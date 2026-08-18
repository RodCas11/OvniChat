import { useCallback, useEffect, useRef, useState } from 'react';

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
  acquireMicrophone,
  MicrophoneAccessError,
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
  readonly participants: readonly VoiceParticipantView[];
  readonly remoteStreams: ReadonlyMap<string, MediaStream>;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly joining: boolean;
  readonly micError: string | undefined;
  readonly lastError: string | undefined;
}

export interface VoiceChannelActions {
  join(channelId: string, displayName: string): void;
  leave(): void;
  setMuted(muted: boolean): void;
  setDeafened(deafened: boolean): void;
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
  participants: [],
  remoteStreams: new Map(),
  muted: false,
  deafened: false,
  joining: false,
  micError: undefined,
  lastError: undefined,
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
        participants: message.participants.map((p) => ({
          participantId: p.participantId,
          displayName: p.displayName,
          connectionState: undefined,
        })),
        remoteStreams: new Map(),
        joining: false,
        lastError: undefined,
      }));
    };

    const onLeft = () => {
      for (const id of currentParticipantIds) transport.removeParticipant(id);
      currentParticipantIds = new Set();
      releaseMicrophone();

      setState((prev) => ({
        ...prev,
        currentChannelId: undefined,
        participants: [],
        remoteStreams: new Map(),
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
        const remoteStreams = new Map(prev.remoteStreams);
        remoteStreams.delete(message.participantId);
        return {
          ...prev,
          participants: prev.participants.filter((p) => p.participantId !== message.participantId),
          remoteStreams,
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
      setState((prev) => {
        const remoteStreams = new Map(prev.remoteStreams);
        remoteStreams.set(event.participantId, event.stream);
        return { ...prev, remoteStreams };
      });
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

  return [state, { join, leave, setMuted, setDeafened }] as const;
}
