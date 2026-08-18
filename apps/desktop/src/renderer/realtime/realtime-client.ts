import {
  CURRENT_PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type ServerErrorMessage,
  type ServerMessage,
  type ServerVoiceCatalogMessage,
  type ServerVoiceJoinedMessage,
  type ServerVoiceLeftMessage,
  type ServerVoiceParticipantJoinedMessage,
  type ServerVoiceParticipantLeftMessage,
  type ServerWebrtcAnswerMessage,
  type ServerWebrtcIceCandidateMessage,
  type ServerWebrtcOfferMessage,
} from '@disco-voador/protocol';
import type { ParticipantId, SignalingPort } from '@disco-voador/rtc-core';

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
  serverError: (message: ServerErrorMessage) => void;
}

function generateMessageId(): string {
  return crypto.randomUUID();
}

/**
 * Renderer-side realtime WebSocket client. Owns the T2 handshake (`client:hello`/`server:hello`)
 * and the T3 voice/WebRTC signaling wire format, and implements rtc-core's `SignalingPort`
 * directly so a `P2PMeshTransport` can send signaling through it with no adapter layer. This class
 * only ever carries text/signaling — never a media payload, per `docs/SECURITY.md`.
 *
 * Server-driven WebSocket protocol-level ping/pong (handled transparently by the platform's
 * `WebSocket` implementation) is enough to keep the connection alive; this client does not run its
 * own `client:ping` loop.
 */
export class RealtimeClient implements SignalingPort {
  private socket: WebSocket | undefined;
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
      serverError: new Set(),
    };

  constructor(private readonly url: string) {}

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
      this.send({
        type: 'client:hello',
        id: generateMessageId(),
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        client: { name: 'disco-voador-desktop', version: '0.0.0' },
      });
    });

    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      this.handleRawMessage(event.data);
    });

    socket.addEventListener('close', () => {
      this.socket = undefined;
      this.emit('stateChange', 'closed');
    });
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
        this.emit('stateChange', 'open');
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
