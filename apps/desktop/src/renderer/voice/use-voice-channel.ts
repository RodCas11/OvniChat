import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  IceCandidatePayload,
  ServerErrorMessage,
  ServerVoiceCatalogMessage,
  ServerVoiceJoinedMessage,
  ServerVoiceParticipantJoinedMessage,
  ServerVoiceParticipantLeftMessage,
  ServerWebrtcAnswerMessage,
  ServerWebrtcIceCandidateMessage,
  ServerWebrtcOfferMessage,
  VoiceChannelSummary,
} from '@disco-voador/protocol';
import {
  acquireCamera,
  acquireMicrophone,
  CameraAccessError,
  MicrophoneAccessError,
  type Camera,
  type Microphone,
} from '@disco-voador/media-core';
import {
  P2PMeshTransport,
  type PeerConnectionStateEvent,
  type RemoteTrackEvent,
} from '@disco-voador/rtc-core';

import type { DesktopRealtimeConfig } from '../../shared/ipc-contract.js';
import { RealtimeClient, type RealtimeConnectionState } from '../realtime/realtime-client.js';

export interface VoiceParticipantView {
  readonly participantId: string;
  readonly displayName: string;
  readonly connectionState: RTCPeerConnectionState | undefined;
}

export type VoiceConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface VoiceChannelState {
  readonly connectionStatus: VoiceConnectionStatus;
  readonly channels: readonly VoiceChannelSummary[];
  readonly currentChannelId: string | undefined;
  readonly selfParticipantId: string | undefined;
  readonly participants: readonly VoiceParticipantView[];
  readonly remoteAudioStreams: ReadonlyMap<string, MediaStream>;
  readonly remoteVideoStreams: ReadonlyMap<string, MediaStream>;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly joining: boolean;
  readonly micError: string | undefined;
  readonly lastError: string | undefined;
  /** Camera is independent of microphone — see `docs/architecture/WEBRTC_CAMERA.md`. */
  readonly cameraEnabled: boolean;
  /** True while `acquireCamera()` is in flight — lets the UI disable the button so a fast
   * double-click can't start a second concurrent capture attempt on the same device. */
  readonly cameraAcquiring: boolean;
  readonly localCameraStream: MediaStream | undefined;
  readonly cameraError: string | undefined;
}

export interface VoiceChannelActions {
  join(channelId: string, displayName: string): void;
  leave(): void;
  setMuted(muted: boolean): void;
  setDeafened(deafened: boolean): void;
  enableCamera(): void;
  disableCamera(): void;
}

/**
 * `IceCandidatePayload` (zod-inferred) types its optional fields as `T | null | undefined`, while
 * the platform's `RTCIceCandidateInit` types them as `T | null` (no explicit `undefined` in the
 * union) — under `exactOptionalPropertyTypes`, only omitting the key entirely (not assigning
 * `undefined` to it) satisfies that. `null` is a distinct, meaningful value (end-of-candidates
 * hint) and is always passed through.
 */
function toRtcIceCandidateInit(payload: IceCandidatePayload | null): RTCIceCandidateInit | null {
  if (payload === null) return null;
  const init: RTCIceCandidateInit = { candidate: payload.candidate };
  if (payload.sdpMid !== undefined) init.sdpMid = payload.sdpMid;
  if (payload.sdpMLineIndex !== undefined) init.sdpMLineIndex = payload.sdpMLineIndex;
  if (payload.usernameFragment !== undefined) init.usernameFragment = payload.usernameFragment;
  return init;
}

const INITIAL_STATE: VoiceChannelState = {
  connectionStatus: 'connecting',
  channels: [],
  currentChannelId: undefined,
  selfParticipantId: undefined,
  participants: [],
  remoteAudioStreams: new Map(),
  remoteVideoStreams: new Map(),
  muted: false,
  deafened: false,
  joining: false,
  micError: undefined,
  lastError: undefined,
  cameraEnabled: false,
  cameraAcquiring: false,
  localCameraStream: undefined,
  cameraError: undefined,
};

/**
 * Owns one realtime connection plus one P2P mesh transport for the lifetime this hook is mounted,
 * and translates T3's voice/signaling wire events into semantic participants and remote media
 * streams for the UI — per ADR 0006, the UI never sees peer connections directly. Offer/answer
 * ownership follows T3's deterministic rule: participants present when *we* join are added as
 * `'responder'` (they own the offer toward us); a participant who joins *our* already-open channel
 * is added as `'initiator'` (we own the offer toward them).
 */
export function useVoiceChannel(
  realtimeConfig: DesktopRealtimeConfig | undefined,
): readonly [VoiceChannelState, VoiceChannelActions] {
  const [state, setState] = useState<VoiceChannelState>(INITIAL_STATE);

  const clientRef = useRef<RealtimeClient | undefined>(undefined);
  const transportRef = useRef<P2PMeshTransport | undefined>(undefined);
  const microphoneRef = useRef<Microphone | undefined>(undefined);
  const mutedRef = useRef(false);
  const cameraRef = useRef<Camera | undefined>(undefined);
  // Bumped on every enable/disable so a `getUserMedia` call that resolves after the user (or a
  // channel leave/unmount) has already moved on can detect it is stale — see the T3 microphone
  // late-acquisition race this mirrors, in `join()` below.
  const cameraGenerationRef = useRef(0);
  // True for the duration of one `acquireCamera()` call — blocks a second concurrent call (see
  // `enableCamera` for the double-click race this closes).
  const cameraAcquiringRef = useRef(false);

  useEffect(() => {
    if (!realtimeConfig) return undefined;

    const client = new RealtimeClient(realtimeConfig.url);
    const transport = new P2PMeshTransport({ iceServers: realtimeConfig.iceServers }, client);
    clientRef.current = client;
    transportRef.current = transport;

    // Tracked outside React state: drives transport add/remove calls, which must never happen
    // twice for the same participant id and must not depend on React's render/commit timing.
    let currentParticipantIds = new Set<string>();

    function releaseMicrophone(): void {
      const microphone = microphoneRef.current;
      if (!microphone) return;
      transport.unpublishTrack(microphone.track);
      microphone.stop();
      microphoneRef.current = undefined;
    }

    /** Unlike microphone mute, camera OFF always fully stops the device (see task section on
     * camera-mute-vs-stop) — this is the single place that happens, called from `disableCamera()`
     * (user-driven), `onLeft` (voice left), and this effect's own cleanup (unmount/reconnect). */
    function releaseCamera(): void {
      cameraGenerationRef.current += 1;
      const camera = cameraRef.current;
      if (!camera) return;
      transport.unpublishTrack(camera.track);
      camera.stop();
      cameraRef.current = undefined;
    }

    const onStateChange = (connectionState: RealtimeConnectionState) => {
      setState((prev) => ({
        ...prev,
        connectionStatus:
          connectionState === 'open'
            ? 'connected'
            : connectionState === 'connecting'
              ? 'connecting'
              : 'disconnected',
      }));
    };

    const onCatalog = (message: ServerVoiceCatalogMessage) => {
      setState((prev) => ({ ...prev, channels: message.channels }));
    };

    const onJoined = (message: ServerVoiceJoinedMessage) => {
      for (const id of currentParticipantIds) transport.removeParticipant(id);
      currentParticipantIds = new Set(message.participants.map((p) => p.participantId));
      for (const participant of message.participants) {
        transport.addParticipant(participant.participantId, 'responder');
      }

      setState((prev) => ({
        ...prev,
        currentChannelId: message.channelId,
        selfParticipantId: message.participantId,
        participants: message.participants.map((p) => ({
          participantId: p.participantId,
          displayName: p.displayName,
          connectionState: undefined,
        })),
        remoteAudioStreams: new Map(),
        remoteVideoStreams: new Map(),
        joining: false,
        lastError: undefined,
      }));
    };

    const onLeft = () => {
      for (const id of currentParticipantIds) transport.removeParticipant(id);
      currentParticipantIds = new Set();
      releaseMicrophone();
      releaseCamera();

      setState((prev) => ({
        ...prev,
        currentChannelId: undefined,
        selfParticipantId: undefined,
        participants: [],
        remoteAudioStreams: new Map(),
        remoteVideoStreams: new Map(),
        cameraEnabled: false,
        localCameraStream: undefined,
      }));
    };

    const onParticipantJoined = (message: ServerVoiceParticipantJoinedMessage) => {
      currentParticipantIds.add(message.participant.participantId);
      transport.addParticipant(message.participant.participantId, 'initiator');

      setState((prev) => ({
        ...prev,
        participants: [
          ...prev.participants,
          {
            participantId: message.participant.participantId,
            displayName: message.participant.displayName,
            connectionState: undefined,
          },
        ],
      }));
    };

    const onParticipantLeft = (message: ServerVoiceParticipantLeftMessage) => {
      currentParticipantIds.delete(message.participantId);
      transport.removeParticipant(message.participantId);

      setState((prev) => {
        const remoteAudioStreams = new Map(prev.remoteAudioStreams);
        remoteAudioStreams.delete(message.participantId);
        const remoteVideoStreams = new Map(prev.remoteVideoStreams);
        remoteVideoStreams.delete(message.participantId);
        return {
          ...prev,
          participants: prev.participants.filter((p) => p.participantId !== message.participantId),
          remoteAudioStreams,
          remoteVideoStreams,
        };
      });
    };

    const onWebrtcOffer = (message: ServerWebrtcOfferMessage) => {
      void transport.handleRemoteOffer(message.sourceParticipantId, message.sdp);
    };
    const onWebrtcAnswer = (message: ServerWebrtcAnswerMessage) => {
      void transport.handleRemoteAnswer(message.sourceParticipantId, message.sdp);
    };
    const onWebrtcIceCandidate = (message: ServerWebrtcIceCandidateMessage) => {
      void transport.handleRemoteIceCandidate(
        message.sourceParticipantId,
        toRtcIceCandidateInit(message.candidate),
      );
    };

    const onServerError = (message: ServerErrorMessage) => {
      console.error('voice: server rejected a request', message.code, message.message);
      setState((prev) => ({ ...prev, lastError: message.message, joining: false }));
    };

    /**
     * `track.kind` (`'audio'`/`'video'`) is the source discriminator — T4 has exactly one video
     * source, so no separate `TrackSource` metadata is needed (see
     * `docs/architecture/WEBRTC_CAMERA.md`).
     *
     * Detecting "the far side stopped sending this track" is NOT `track.onended`: empirically
     * (confirmed against real Electron 43/Chromium — see `docs/tasks/T4_CAMERA_STREAMING.md`),
     * renegotiating a sender's track away (`unpublishTrack` -> `pc.removeTrack`) does not reliably
     * end the receiver's corresponding remote track — it just stops receiving data. The correct,
     * spec-defined signal for that is the track's `'mute'`/`'unmute'` events (`track.muted`
     * reflects "temporarily unable to provide data"). Camera re-enabling later typically reuses the
     * same transceiver/receiver track (`RTCPeerConnection.addTrack` reuses a stopped-sender,
     * compatible-direction transceiver when one exists), so the remote side sees the *same* track
     * object fire `'unmute'` again rather than a fresh `ontrack` — video wires both events so
     * on/off/on toggling is reflected correctly without leaking stale map entries. Audio
     * deliberately does not react to mute/unmute: microphone mute (`track.enabled = false` on the
     * sender) sends silence rather than stopping data flow, so the receiving track does not mute,
     * and even if a platform did briefly signal it, removing the `<audio>` element for an ordinary
     * mute would be wrong UX — audio's only removal signal is `'ended'`/the participant leaving.
     */
    const onRemoteTrack = (event: RemoteTrackEvent) => {
      const isVideo = event.track.kind === 'video';

      const addToState = () => {
        setState((prev) => {
          const streams = new Map(isVideo ? prev.remoteVideoStreams : prev.remoteAudioStreams);
          streams.set(event.participantId, event.stream);
          return isVideo
            ? { ...prev, remoteVideoStreams: streams }
            : { ...prev, remoteAudioStreams: streams };
        });
      };

      const removeFromState = () => {
        setState((prev) => {
          const streams = new Map(isVideo ? prev.remoteVideoStreams : prev.remoteAudioStreams);
          streams.delete(event.participantId);
          return isVideo
            ? { ...prev, remoteVideoStreams: streams }
            : { ...prev, remoteAudioStreams: streams };
        });
      };

      event.track.addEventListener('ended', removeFromState);
      if (isVideo) {
        event.track.addEventListener('mute', removeFromState);
        event.track.addEventListener('unmute', addToState);
      }

      addToState();
    };

    const onPeerStateChanged = (event: PeerConnectionStateEvent) => {
      setState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.participantId === event.participantId
            ? { ...p, connectionState: event.connectionState }
            : p,
        ),
      }));
    };

    client.on('stateChange', onStateChange);
    client.on('catalog', onCatalog);
    client.on('joined', onJoined);
    client.on('left', onLeft);
    client.on('participantJoined', onParticipantJoined);
    client.on('participantLeft', onParticipantLeft);
    client.on('webrtcOffer', onWebrtcOffer);
    client.on('webrtcAnswer', onWebrtcAnswer);
    client.on('webrtcIceCandidate', onWebrtcIceCandidate);
    client.on('serverError', onServerError);
    transport.on('remoteTrack', onRemoteTrack);
    transport.on('peerStateChanged', onPeerStateChanged);

    client.connect();

    return () => {
      client.off('stateChange', onStateChange);
      client.off('catalog', onCatalog);
      client.off('joined', onJoined);
      client.off('left', onLeft);
      client.off('participantJoined', onParticipantJoined);
      client.off('participantLeft', onParticipantLeft);
      client.off('webrtcOffer', onWebrtcOffer);
      client.off('webrtcAnswer', onWebrtcAnswer);
      client.off('webrtcIceCandidate', onWebrtcIceCandidate);
      client.off('serverError', onServerError);
      transport.off('remoteTrack', onRemoteTrack);
      transport.off('peerStateChanged', onPeerStateChanged);

      client.disconnect();
      // The transport is discarded along with this effect run — permanent teardown is correct
      // here, unlike a mid-session channel switch (`onJoined`/`onLeft` above use
      // `removeParticipant`, never `closeAll`, since `closeAll` permanently disables the
      // transport).
      transport.closeAll();
      microphoneRef.current?.stop();
      microphoneRef.current = undefined;
      cameraGenerationRef.current += 1;
      cameraRef.current?.stop();
      cameraRef.current = undefined;
      clientRef.current = undefined;
      transportRef.current = undefined;
    };
  }, [realtimeConfig]);

  const join = useCallback((channelId: string, displayName: string) => {
    const client = clientRef.current;
    const transport = transportRef.current;
    if (!client || !transport) return;

    setState((prev) => ({ ...prev, joining: true, lastError: undefined, micError: undefined }));

    void (async () => {
      if (!microphoneRef.current) {
        try {
          const microphone = await acquireMicrophone();
          if (transportRef.current !== transport) {
            // This effect's connection/transport was torn down (unmount, or `realtimeConfig`
            // changed) while `getUserMedia` was pending. Stop the device immediately instead of
            // leaking the hardware microphone or publishing a track to a dead transport.
            microphone.stop();
            return;
          }
          microphone.setMuted(mutedRef.current);
          microphoneRef.current = microphone;
          transport.publishTrack(microphone.track);
        } catch (error) {
          const message =
            error instanceof MicrophoneAccessError ? error.message : 'Microphone access failed';
          console.error('voice: microphone acquisition failed', message, error);
          setState((prev) => ({ ...prev, micError: message, joining: false }));
          return;
        }
      }

      client.joinVoiceChannel(channelId, displayName);
    })();
  }, []);

  const leave = useCallback(() => {
    clientRef.current?.leaveVoiceChannel();
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
    microphoneRef.current?.setMuted(muted);
    setState((prev) => ({ ...prev, muted }));
  }, []);

  const setDeafened = useCallback((deafened: boolean) => {
    setState((prev) => ({ ...prev, deafened }));
  }, []);

  const enableCamera = useCallback(() => {
    const transport = transportRef.current;
    // `cameraAcquiringRef` blocks a *second* concurrent `acquireCamera()` call for as long as one
    // is already in flight — even across an intervening `disableCamera()` — because many real
    // webcams only support one open capture handle at a time; without this, a fast double-click
    // (the button has no `disabled`-during-acquisition state to rely on instead) could start two
    // concurrent `getUserMedia` calls, and if the *stale* one happens to be the one that succeeds,
    // the user sees a spurious camera error after a single intended click. Found by QA review, not
    // by the live E2E (which never exercises rapid double-invocation).
    if (!transport || cameraRef.current || cameraAcquiringRef.current) return;

    cameraAcquiringRef.current = true;
    const generation = ++cameraGenerationRef.current;
    setState((prev) => ({ ...prev, cameraError: undefined, cameraAcquiring: true }));

    void (async () => {
      try {
        const camera = await acquireCamera();
        if (transportRef.current !== transport || cameraGenerationRef.current !== generation) {
          // The transport was torn down, or the user disabled the camera again (or enabled it a
          // second time — the generation counter only ever matches the most recent call) while
          // `getUserMedia` was pending. Stop the device immediately instead of leaking the
          // hardware camera or publishing a track nobody asked for anymore — the same class of
          // race T3 fixed for the microphone.
          camera.stop();
          return;
        }

        cameraRef.current = camera;
        camera.track.addEventListener('ended', () => {
          // The physical device stopped unexpectedly (unplugged, revoked, etc.) rather than via
          // `disableCamera()` — `cameraRef.current !== camera` means `disableCamera()` (or a
          // newer `enableCamera()`) already handled cleanup for this instance, so this is a no-op.
          if (cameraRef.current !== camera) return;
          cameraRef.current = undefined;
          transport.unpublishTrack(camera.track);
          setState((prev) => ({ ...prev, cameraEnabled: false, localCameraStream: undefined }));
        });

        transport.publishTrack(camera.track);
        setState((prev) => ({ ...prev, cameraEnabled: true, localCameraStream: camera.stream }));
      } catch (error) {
        const message = error instanceof CameraAccessError ? error.message : 'Camera access failed';
        console.error('voice: camera acquisition failed', message, error);
        setState((prev) => ({ ...prev, cameraError: message }));
      } finally {
        cameraAcquiringRef.current = false;
        setState((prev) => ({ ...prev, cameraAcquiring: false }));
      }
    })();
  }, []);

  const disableCamera = useCallback(() => {
    cameraGenerationRef.current += 1;
    const transport = transportRef.current;
    const camera = cameraRef.current;
    cameraRef.current = undefined;
    if (transport && camera) transport.unpublishTrack(camera.track);
    camera?.stop();
    setState((prev) => ({ ...prev, cameraEnabled: false, localCameraStream: undefined }));
  }, []);

  // Memoized so callers holding `actions` in a `useEffect` dependency array (e.g. the E2E
  // auto-camera-off timer in `VoiceChannelView.tsx`) get a stable reference instead of one that
  // changes on every render — each individual action is already a `useCallback` with empty deps,
  // so this object's own identity is stable for the component's whole lifetime.
  const actions = useMemo<VoiceChannelActions>(
    () => ({ join, leave, setMuted, setDeafened, enableCamera, disableCamera }),
    [join, leave, setMuted, setDeafened, enableCamera, disableCamera],
  );

  return [state, actions] as const;
}
