import {
  CURRENT_PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type ServerErrorMessage,
  type ServerIdentityChallengeMessage,
  type ServerMediaTrackSourceMessage,
  type ServerMessage,
  type ServerVoiceCatalogMessage,
  type ServerVoiceJoinedMessage,
  type ServerVoiceLeftMessage,
  type ServerVoiceParticipantJoinedMessage,
  type ServerVoiceParticipantLeftMessage,
  type ServerWebrtcAnswerMessage,
  type ServerWebrtcIceCandidateMessage,
  type ServerWebrtcOfferMessage,
  type TrackSource,
} from '@disco-voador/protocol';
import type { ParticipantId, SignalingPort } from '@disco-voador/rtc-core';

import type { IdentitySigner } from './identity-signer.js';

export type RealtimeConnectionState = 'connecting' | 'open' | 'closed';

interface RealtimeClientEvents {
  stateChange: (state: RealtimeConnectionState) => void;
  catalog: (message: ServerVoiceCatalogMessage) => void;
  joined: (message: ServerVoiceJoinedMessage) => void;
  left: (message: ServerVoiceLeftMessage) => void;
  participantJoined: (message: ServerVoiceParticipantJoinedMessage) => void;
  participantLeft: (message: ServerVoiceParticipantLeftMessage) => void;
  webrtcOffer: (message: ServerWebrtcOfferMessage) => void;
  webrtcAnswer: (message: ServerWebrtcAnswerMessage) => void;
  webrtcIceCandidate: (message: ServerWebrtcIceCandidateMessage) => void;
  mediaTrackSource: (message: ServerMediaTrackSourceMessage) => void;
  serverError: (message: ServerErrorMessage) => void;
}

function generateMessageId(): string {
  return crypto.randomUUID();
}

/**
 * Renderer-side realtime WebSocket client. Owns the T2/T7 handshake (`client:hello` ->
 * `server:identity-challenge` -> `client:identity-proof` -> `server:hello`) and the T3 voice/
 * WebRTC signaling wire format, and implements rtc-core's `SignalingPort` directly so a
 * `P2PMeshTransport` can send signaling through it with no adapter layer. This class only ever
 * carries text/signaling — never a media payload, per `docs/SECURITY.md`.
 *
 * The private key itself never passes through this class or the Renderer at all — every identity
 * operation goes through the injected {@link IdentitySigner}, which is IPC-shaped (see
 * `identity-signer.ts`); this class only ever handles public data (`publicKey`, `identityId`,
 * `nickname`) and opaque signature strings.
 *
 * Server-driven WebSocket protocol-level ping/pong (handled transparently by the platform's
 * `WebSocket` implementation) is enough to keep the connection alive; this client does not run its
 * own `client:ping` loop.
 */
export class RealtimeClient implements SignalingPort {
  private socket: WebSocket | undefined;
  /** The nickname actually sent in the most recent `client:hello` — captured once at hello time
   * so a nickname change while a challenge is outstanding can never desync the client's proof
   * from what the server is verifying against (the server always uses the nickname it received
   * at hello, never a later value). */
  private currentNickname = '';
  private readonly listeners: { [K in keyof RealtimeClientEvents]: Set<RealtimeClientEvents[K]> } =
    {
      stateChange: new Set(),
      catalog: new Set(),
      joined: new Set(),
      left: new Set(),
      participantJoined: new Set(),
      participantLeft: new Set(),
      webrtcOffer: new Set(),
      webrtcAnswer: new Set(),
      webrtcIceCandidate: new Set(),
      mediaTrackSource: new Set(),
      serverError: new Set(),
    };

  constructor(
    private readonly url: string,
    private readonly signer: IdentitySigner,
  ) {}

  on<K extends keyof RealtimeClientEvents>(event: K, listener: RealtimeClientEvents[K]): void {
    this.listeners[event].add(listener);
  }

  off<K extends keyof RealtimeClientEvents>(event: K, listener: RealtimeClientEvents[K]): void {
    this.listeners[event].delete(listener);
  }

  connect(): void {
    if (this.socket) return;
    this.emit('stateChange', 'connecting');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      void this.sendHello(socket);
    });

    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      this.handleRawMessage(event.data);
    });

    socket.addEventListener('close', () => {
      this.socket = undefined;
      this.emit('stateChange', 'closed');
    });
  }

  /** Loads the local public identity and current nickname, then sends `client:hello`. Async
   * because both come from Main over IPC — `socket` is the exact instance `connect()` just
   * created, checked against `this.socket` after each await so a torn-down/replaced connection
   * (unmount, reconnect) while this was in flight is a silent no-op rather than sending a hello on
   * a dead or unrelated socket, mirroring the same staleness guard `use-voice-channel.ts` already
   * uses for `getUserMedia`/`getDisplayMedia`. */
  private async sendHello(socket: WebSocket): Promise<void> {
    let publicKey: string;
    let nickname: string;
    try {
      const [identity, currentNickname] = await Promise.all([
        this.signer.getPublicIdentity(),
        this.signer.getNickname(),
      ]);
      if (this.socket !== socket) return;
      publicKey = identity.publicKey;
      nickname = currentNickname;
    } catch (error) {
      console.error('realtime-client: failed to load the local identity', error);
      socket.close(1011, 'identity unavailable');
      return;
    }

    this.currentNickname = nickname;
    this.send({
      type: 'client:hello',
      id: generateMessageId(),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      client: { name: 'disco-voador-desktop', version: '0.0.0' },
      nickname,
      publicKey,
    });
  }

  /** Answers `server:identity-challenge` by asking the signer to sign it, then sends
   * `client:identity-proof` — the only path that can make the connection `ready`
   * (`server:hello`). Never reconstructs the canonical payload itself; that is the signer's (in
   * practice, Main's) job specifically so the Renderer never needs — and never gets — the
   * building blocks to sign anything else. */
  private async handleIdentityChallenge(message: ServerIdentityChallengeMessage): Promise<void> {
    const socket = this.socket;
    if (!socket) return;

    let signature: string;
    try {
      signature = await this.signer.signIdentityChallenge({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        connectionId: message.connectionId,
        nonce: message.nonce,
        expiresAt: message.expiresAt,
        nickname: this.currentNickname,
      });
    } catch (error) {
      console.error('realtime-client: failed to sign the identity challenge', error);
      socket.close(1011, 'identity signing failed');
      return;
    }
    if (this.socket !== socket) return;

    this.send({ type: 'client:identity-proof', id: generateMessageId(), signature });
  }

  /**
   * Idempotent; safe to call whether or not `connect()` ever succeeded. Deliberately does not
   * clear `this.socket` or emit `'stateChange'` itself — the `'close'` listener registered in
   * `connect()` already does both, and fires for this client-initiated close exactly the same way
   * it fires for a server-initiated one, so there is exactly one code path for "the socket closed."
   */
  disconnect(): void {
    this.socket?.close(1000, 'client disconnect');
  }

  joinVoiceChannel(channelId: string, displayName: string): void {
    this.send({ type: 'voice:join', id: generateMessageId(), channelId, displayName });
  }

  leaveVoiceChannel(): void {
    this.send({ type: 'voice:leave', id: generateMessageId() });
  }

  sendOffer(targetParticipantId: ParticipantId, sdp: string): void {
    this.send({ type: 'webrtc:offer', id: generateMessageId(), targetParticipantId, sdp });
  }

  sendAnswer(targetParticipantId: ParticipantId, sdp: string): void {
    this.send({ type: 'webrtc:answer', id: generateMessageId(), targetParticipantId, sdp });
  }

  sendIceCandidate(
    targetParticipantId: ParticipantId,
    candidate: RTCIceCandidateInit | null,
  ): void {
    this.send({
      type: 'webrtc:ice-candidate',
      id: generateMessageId(),
      targetParticipantId,
      candidate:
        candidate === null
          ? null
          : {
              candidate: candidate.candidate ?? '',
              sdpMid: candidate.sdpMid ?? undefined,
              sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
              usernameFragment: candidate.usernameFragment ?? undefined,
            },
    });
  }

  /**
   * Announces the semantic source (camera vs. screen-video — see `packages/protocol`'s `media.ts`
   * and `docs/architecture/WEBRTC_SCREEN_SHARE.md`) of a local track, by the `mid` that track's
   * transceiver negotiated *for the connection to `targetParticipantId`* — mid is scoped to one
   * peer connection (the same local track can have a different mid on a different peer connection
   * in the mesh), so this is targeted per-peer, not a channel-wide broadcast. Sent directly rather
   * than through `SignalingPort`/`Peer` since `rtc-core` stays protocol-agnostic; `Peer`'s
   * `localTrackMid` event (via `P2PMeshTransport`) is what tells the caller when/what to announce.
   */
  announceTrackSource(targetParticipantId: ParticipantId, mid: string, source: TrackSource): void {
    this.send({
      type: 'media:track-source',
      id: generateMessageId(),
      targetParticipantId,
      mid,
      source,
    });
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error('realtime-client: dropped a message because the socket is not open', {
        type: message.type,
      });
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private handleRawMessage(data: unknown): void {
    if (typeof data !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.error('realtime-client: received malformed JSON from the server');
      return;
    }

    const result = parseServerMessage(parsed);
    if (!result.ok) {
      console.error(
        'realtime-client: received a message that failed protocol validation',
        result.issues,
      );
      return;
    }

    this.dispatch(result.message);
  }

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case 'server:hello':
        // Public data only — used by the T7 identity-authentication E2E script to confirm this
        // connection's server-verified identityId matches the local one logged by
        // `use-identity.ts`. See `apps/desktop/scripts/e2e-identity-auth.mjs`.
        console.info(`disco-voador:server-authenticated-identity:${message.identityId}`);
        this.emit('stateChange', 'open');
        return;
      case 'server:identity-challenge':
        void this.handleIdentityChallenge(message);
        return;
      case 'server:pong':
        return;
      case 'server:error':
        this.emit('serverError', message);
        return;
      case 'voice:catalog':
        this.emit('catalog', message);
        return;
      case 'voice:joined':
        this.emit('joined', message);
        return;
      case 'voice:left':
        this.emit('left', message);
        return;
      case 'voice:participant-joined':
        this.emit('participantJoined', message);
        return;
      case 'voice:participant-left':
        this.emit('participantLeft', message);
        return;
      case 'webrtc:offer':
        this.emit('webrtcOffer', message);
        return;
      case 'webrtc:answer':
        this.emit('webrtcAnswer', message);
        return;
      case 'webrtc:ice-candidate':
        this.emit('webrtcIceCandidate', message);
        return;
      case 'media:track-source':
        this.emit('mediaTrackSource', message);
        return;
    }
  }

  private emit<K extends keyof RealtimeClientEvents>(
    event: K,
    ...args: Parameters<RealtimeClientEvents[K]>
  ): void {
    for (const listener of [...this.listeners[event]]) {
      (listener as (...eventArgs: Parameters<RealtimeClientEvents[K]>) => void)(...args);
    }
  }
}
