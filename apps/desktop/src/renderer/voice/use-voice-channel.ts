import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  IceCandidatePayload,
  ServerErrorMessage,
  ServerMediaTrackSourceMessage,
  ServerVoiceCatalogMessage,
  ServerVoiceJoinedMessage,
  ServerVoiceParticipantJoinedMessage,
  ServerVoiceParticipantLeftMessage,
  ServerWebrtcAnswerMessage,
  ServerWebrtcIceCandidateMessage,
  ServerWebrtcOfferMessage,
  TrackSource,
  VoiceChannelSummary,
} from '@disco-voador/protocol';
import {
  acquireCamera,
  acquireMicrophone,
  acquireScreen,
  CameraAccessError,
  MicrophoneAccessError,
  ScreenAccessError,
  SCREEN_QUALITY_PRESETS,
  type Camera,
  type Microphone,
  type Screen,
  type ScreenQualityPreset,
} from '@disco-voador/media-core';
import {
  P2PMeshTransport,
  type LocalTrackMidEvent,
  type PeerConnectionStateEvent,
  type RemoteTrackEvent,
} from '@disco-voador/rtc-core';

import type { DesktopRealtimeConfig } from '../../shared/ipc-contract.js';
import { IpcIdentitySigner } from '../realtime/identity-signer.js';
import { RealtimeClient, type RealtimeConnectionState } from '../realtime/realtime-client.js';
import {
  createEmptyRemoteMediaStreamsState,
  RemoteMediaReconciler,
} from './remote-media-reconciliation.js';
import { releasePublishedScreen } from './screen-share-lifecycle.js';

export interface VoiceParticipantView {
  readonly participantId: string;
  readonly displayName: string;
  readonly connectionState: RTCPeerConnectionState | undefined;
}

export type VoiceConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * Not-sharing/starting/sharing/error — an explicit state, not a boolean, per T5's requirement that
 * screen-share UI state be unambiguous. There is no separate transitional "stopping" state:
 * `disableScreenShare()`'s own work (`unpublishTrack` + `screen.stop()`) is synchronous from this
 * hook's point of view — same as `disableCamera()` — so a "stopping" state would have no observable
 * duration to occupy; the renegotiation that follows unpublish happens the same fire-and-forget way
 * camera's already-proven disable path does.
 */
export type ScreenSharingState = 'idle' | 'starting' | 'sharing' | 'error';

export interface VoiceChannelState {
  readonly connectionStatus: VoiceConnectionStatus;
  readonly channels: readonly VoiceChannelSummary[];
  readonly currentChannelId: string | undefined;
  readonly selfParticipantId: string | undefined;
  readonly participants: readonly VoiceParticipantView[];
  /** Remote microphone audio only — see `TrackSource`. Screen-audio lives in
   * `remoteScreenAudioStreams`, never mixed into this map, even though both are
   * `track.kind === 'audio'` (T6). */
  readonly remoteAudioStreams: ReadonlyMap<string, MediaStream>;
  /** Remote camera video only — see `TrackSource`. Screen-video lives in `remoteScreenStreams`,
   * never mixed into this map, even though both are `track.kind === 'video'`. */
  readonly remoteCameraStreams: ReadonlyMap<string, MediaStream>;
  readonly remoteScreenStreams: ReadonlyMap<string, MediaStream>;
  /** Remote screen/system audio only (T6) — see `TrackSource`. Independent of
   * `remoteAudioStreams` (microphone); a participant sharing screen audio while also talking has
   * both maps populated at once, each with its own playback ownership (see `RemoteAudio.tsx`). */
  readonly remoteScreenAudioStreams: ReadonlyMap<string, MediaStream>;
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
  /** Screen share is a third independent source alongside microphone and camera — see
   * `docs/architecture/WEBRTC_SCREEN_SHARE.md`. */
  readonly screenSharingState: ScreenSharingState;
  readonly localScreenStream: MediaStream | undefined;
  readonly screenShareError: string | undefined;
  /** True only once the current screen share's system-audio track has actually been acquired and
   * published — distinct from "the user checked Share audio", since audio is optional and can be
   * requested but unavailable (see `docs/architecture/WEBRTC_SCREEN_AUDIO.md`). Independent of
   * `screenSharingState`: audio can end on its own (its track's own `'ended'` handler, see
   * `enableScreenShare`) while video keeps sharing. */
  readonly screenShareAudioActive: boolean;
}

export interface VoiceChannelActions {
  join(channelId: string, displayName: string): void;
  leave(): void;
  setMuted(muted: boolean): void;
  setDeafened(deafened: boolean): void;
  enableCamera(): void;
  disableCamera(): void;
  /** Call only after a source has already been armed via `desktopApp.selectScreenShareSource`
   * (e.g. by `ScreenSourcePicker`'s `onSourceSelected`) — this does not itself select a source, it
   * only acquires (`getDisplayMedia()`, fulfilled by whatever Main already has pending) and
   * publishes whatever that selection resolves to. `shareAudio` must match what was armed via
   * `selectScreenShareSource` for this same share (see `ScreenSourcePicker`'s doc comment) — video
   * is always published; the audio track is published too only if `shareAudio` was `true` and the
   * platform actually supplied one (optional, never a failure of the share itself). */
  enableScreenShare(quality: ScreenQualityPreset, shareAudio: boolean): void;
  disableScreenShare(): void;
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
  remoteCameraStreams: new Map(),
  remoteScreenStreams: new Map(),
  remoteScreenAudioStreams: new Map(),
  muted: false,
  deafened: false,
  joining: false,
  micError: undefined,
  lastError: undefined,
  cameraEnabled: false,
  cameraAcquiring: false,
  localCameraStream: undefined,
  cameraError: undefined,
  screenSharingState: 'idle',
  localScreenStream: undefined,
  screenShareError: undefined,
  screenShareAudioActive: false,
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
  const screenRef = useRef<Screen | undefined>(undefined);
  // Same late-acquisition-race and double-click protections as camera's, mirrored exactly for
  // `getDisplayMedia()` — see `enableScreenShare`.
  const screenGenerationRef = useRef(0);
  const screenAcquiringRef = useRef(false);

  useEffect(() => {
    if (!realtimeConfig) return undefined;

    const client = new RealtimeClient(realtimeConfig.url, new IpcIdentitySigner());
    const transport = new P2PMeshTransport({ iceServers: realtimeConfig.iceServers }, client);
    clientRef.current = client;
    transportRef.current = transport;

    // Tracked outside React state: drives transport add/remove calls, which must never happen
    // twice for the same participant id and must not depend on React's render/commit timing.
    let currentParticipantIds = new Set<string>();

    // T5 introduced this reconciliation for video (camera vs. screen-video); T6 extends it to
    // audio (microphone vs. screen-audio) for the identical reason. `media:track-source` (announced
    // by `onLocalTrackMid` below, once `rtc-core` reports a local track's negotiated `mid` for a
    // specific peer) and `ontrack` (the transport's `remoteTrack` event, itself carrying the
    // *remote* side's view of that same mid) arrive independently and in no guaranteed order
    // relative to each other, for every source kind. Neither side is ever inferred (e.g. "no
    // announcement yet, so assume camera/microphone") — see
    // `docs/architecture/WEBRTC_SCREEN_SHARE.md`'s "Media source identity" and
    // `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "Media identity" sections. The full reconciler
    // (pending/wired/source-by-key bookkeeping, mid-reuse handling, the two real bugs this exact
    // logic has already produced and their fixes) lives in `remote-media-reconciliation.ts` — kept
    // as a plain, React-free class specifically so it has direct unit test coverage instead of
    // relying solely on a live two-instance E2E run. Reset on every reconnect/rejoin (`onJoined`/
    // `onLeft` below), matching `currentParticipantIds`.
    const reconciler = new RemoteMediaReconciler({
      updateStreams: (updater) => {
        setState((prev) => ({ ...prev, ...updater(prev) }));
      },
      onMissingAnnouncement: (participantId, mid, kind) => {
        console.error(
          `voice: no media:track-source announcement arrived for a remote ${kind} track`,
          {
            participantId,
            mid,
          },
        );
      },
    });

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

    /** Mirrors `releaseCamera()` exactly — screen share off always fully releases capture too. */
    function releaseScreen(): void {
      screenGenerationRef.current += 1;
      const screen = screenRef.current;
      if (!screen) return;
      screenRef.current = undefined;
      releasePublishedScreen(transport, screen);
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
      reconciler.reset();
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
        ...createEmptyRemoteMediaStreamsState(),
        joining: false,
        lastError: undefined,
      }));
    };

    const onLeft = () => {
      for (const id of currentParticipantIds) transport.removeParticipant(id);
      currentParticipantIds = new Set();
      reconciler.reset();
      releaseMicrophone();
      releaseCamera();
      releaseScreen();

      setState((prev) => ({
        ...prev,
        currentChannelId: undefined,
        selfParticipantId: undefined,
        participants: [],
        ...createEmptyRemoteMediaStreamsState(),
        cameraEnabled: false,
        localCameraStream: undefined,
        screenSharingState: 'idle',
        localScreenStream: undefined,
        screenShareAudioActive: false,
      }));
    };

    const onParticipantJoined = (message: ServerVoiceParticipantJoinedMessage) => {
      currentParticipantIds.add(message.participant.participantId);
      transport.addParticipant(message.participant.participantId, 'initiator');
      // No explicit re-announce needed for this new peer's view of any already-active camera/screen
      // track: `addParticipant` seeds it into this new peer connection and sends that connection's
      // own initial offer (see `P2PMeshTransport.addParticipant`), which makes `Peer` report this
      // connection's `localTrackMid` for it just like any other peer — `onLocalTrackMid` below
      // announces to *that* new participant then, with *that* connection's own negotiated mid.

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
      reconciler.removeParticipant(message.participantId);

      setState((prev) => {
        return {
          ...prev,
          participants: prev.participants.filter((p) => p.participantId !== message.participantId),
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

    const onRemoteTrack = (event: RemoteTrackEvent) => {
      reconciler.handleRemoteTrack(event);
    };

    const onMediaTrackSource = (message: ServerMediaTrackSourceMessage) => {
      reconciler.handleMediaTrackSource(message.sourceParticipantId, message.mid, message.source);
    };

    /**
     * Announces a local track's semantic source to exactly the one peer this `mid` was just
     * negotiated with (see `RealtimeClient.announceTrackSource`'s doc comment for why this is
     * targeted, not a broadcast). Fired by `rtc-core` once per successful offer for every currently
     * local-tracked sender. T6: microphone is now announced too, symmetrically with every other
     * source (see `TrackSource`'s doc comment in `packages/protocol` for why leaving it as an
     * unannounced default would itself be the absence-based inference this design forbids) —
     * `source` is `undefined` only for a track this hook genuinely does not recognize at all
     * (should not happen for any currently-published track).
     */
    const onLocalTrackMid = (event: LocalTrackMidEvent) => {
      const source: TrackSource | undefined =
        event.track === microphoneRef.current?.track
          ? 'microphone'
          : event.track === cameraRef.current?.track
            ? 'camera'
            : event.track === screenRef.current?.track
              ? 'screen-video'
              : event.track === screenRef.current?.audioTrack
                ? 'screen-audio'
                : undefined;
      if (!source) return;
      client.announceTrackSource(event.participantId, event.mid, source);
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
    client.on('mediaTrackSource', onMediaTrackSource);
    client.on('serverError', onServerError);
    transport.on('remoteTrack', onRemoteTrack);
    transport.on('localTrackMid', onLocalTrackMid);
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
      client.off('mediaTrackSource', onMediaTrackSource);
      client.off('serverError', onServerError);
      transport.off('remoteTrack', onRemoteTrack);
      transport.off('localTrackMid', onLocalTrackMid);
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
      screenGenerationRef.current += 1;
      screenRef.current?.stop();
      screenRef.current = undefined;
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
        // T5: camera's video source must be identified explicitly too, symmetrically with screen —
        // once both exist, leaving camera unannounced and treating "no announcement" as an implicit
        // default would itself be a form of order/absence-based inference, exactly what T5's
        // protocol design set out to avoid. The actual announcement is driven by `onLocalTrackMid`
        // above, once `rtc-core` reports this track's negotiated mid for each peer — not here,
        // since the mid isn't known yet at publish time. See
        // `docs/architecture/WEBRTC_SCREEN_SHARE.md`.
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

  const enableScreenShare = useCallback((quality: ScreenQualityPreset, shareAudio: boolean) => {
    const transport = transportRef.current;
    // Mirrors `enableCamera`'s double-click/concurrent-acquisition guard exactly — the same class
    // of real bug T4 found for camera (a fast double-invocation starting two concurrent capture
    // attempts) applies identically here.
    if (!transport || screenRef.current || screenAcquiringRef.current) return;

    screenAcquiringRef.current = true;
    const generation = ++screenGenerationRef.current;
    setState((prev) => ({ ...prev, screenShareError: undefined, screenSharingState: 'starting' }));

    void (async () => {
      try {
        const screen = await acquireScreen(SCREEN_QUALITY_PRESETS[quality], shareAudio);
        if (transportRef.current !== transport || screenGenerationRef.current !== generation) {
          // The transport was torn down, or the user stopped sharing again (or started a second
          // share — the generation counter only ever matches the most recent call) while
          // `getDisplayMedia()` was pending. Stop the device immediately instead of leaking the
          // capture or publishing a track nobody asked for anymore — the same race class T3 fixed
          // for the microphone and T4 fixed for the camera. `screen.stop()` releases both video
          // and (if present) audio.
          screen.stop();
          return;
        }

        screenRef.current = screen;
        screen.track.addEventListener('ended', () => {
          // Native capture ended externally — the OS/browser-style "Stop sharing" control, or the
          // captured window was closed — rather than via `disableScreenShare()`.
          // `screenRef.current !== screen` means `disableScreenShare()` (or a newer
          // `enableScreenShare()`) already handled cleanup for this instance, so this is a no-op.
          // T6: video ending externally always tears down audio too — system audio must never keep
          // broadcasting after the visual share ended.
          if (screenRef.current !== screen) return;
          screenRef.current = undefined;
          releasePublishedScreen(transport, screen);
          setState((prev) => ({
            ...prev,
            screenSharingState: 'idle',
            localScreenStream: undefined,
            screenShareAudioActive: false,
          }));
        });

        transport.publishTrack(screen.track);
        // Announced by `onLocalTrackMid` once each peer's negotiated mid for this track is known —
        // see the identical comment in `enableCamera`.
        let audioActive = false;
        const audioTrack = screen.audioTrack;
        if (audioTrack) {
          audioActive = true;
          // Both `publishTrack` calls happen synchronously in this same task — the platform's own
          // `negotiationneeded` batching (see `packages/rtc-core/src/peer.ts`) coalesces them into
          // one renegotiation cycle for this share-start, not two.
          transport.publishTrack(audioTrack);
          // T6: system audio can independently stop supplying data (source app closed, platform
          // revoked it) while video keeps sharing — must not end the whole share, only mark audio
          // unavailable. `screenRef.current !== screen` means the video 'ended' handler above (or
          // `disableScreenShare()`) already handled full cleanup for this instance.
          audioTrack.addEventListener('ended', () => {
            if (screenRef.current !== screen) return;
            transport.unpublishTrack(audioTrack);
            setState((prev) => ({ ...prev, screenShareAudioActive: false }));
          });
        }

        setState((prev) => ({
          ...prev,
          screenSharingState: 'sharing',
          localScreenStream: screen.stream,
          screenShareAudioActive: audioActive,
        }));
      } catch (error) {
        const message = error instanceof ScreenAccessError ? error.message : 'Screen share failed';
        console.error('voice: screen share acquisition failed', message, error);
        setState((prev) => ({ ...prev, screenShareError: message, screenSharingState: 'error' }));
      } finally {
        screenAcquiringRef.current = false;
      }
    })();
  }, []);

  const disableScreenShare = useCallback(() => {
    screenGenerationRef.current += 1;
    const transport = transportRef.current;
    const screen = screenRef.current;
    screenRef.current = undefined;
    if (transport && screen) releasePublishedScreen(transport, screen);
    else screen?.stop();
    setState((prev) => ({
      ...prev,
      screenSharingState: 'idle',
      localScreenStream: undefined,
      screenShareAudioActive: false,
    }));
  }, []);

  // Memoized so callers holding `actions` in a `useEffect` dependency array (e.g. the E2E
  // auto-camera-off timer in `VoiceChannelView.tsx`) get a stable reference instead of one that
  // changes on every render — each individual action is already a `useCallback` with empty deps,
  // so this object's own identity is stable for the component's whole lifetime.
  const actions = useMemo<VoiceChannelActions>(
    () => ({
      join,
      leave,
      setMuted,
      setDeafened,
      enableCamera,
      disableCamera,
      enableScreenShare,
      disableScreenShare,
    }),
    [
      join,
      leave,
      setMuted,
      setDeafened,
      enableCamera,
      disableCamera,
      enableScreenShare,
      disableScreenShare,
    ],
  );

  return [state, actions] as const;
}
