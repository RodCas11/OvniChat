import { Peer } from './peer.js';
import { createRtcPeerConnection, type RtcPeerConnectionLike } from './rtc-peer-connection.js';
import type {
  MediaTransport,
  MediaTransportEvents,
  ParticipantId,
  RtcTransportConfig,
  SignalingPort,
} from './types.js';

export interface P2PMeshTransportOptions {
  /** Overrides how `RTCPeerConnection`s are constructed — tests only; see `rtc-peer-connection.ts`. */
  createPeerConnection?: (config: RtcTransportConfig) => RtcPeerConnectionLike;
}

/**
 * ADR 0006's first transport: one `RTCPeerConnection` (owned by one `Peer`) per remote
 * participant. This class is the only place that decides mesh topology, offer/answer role
 * assignment, and track fan-out to every peer; it presents the environment-neutral
 * {@link MediaTransport} contract so callers never see mesh internals (peers, transceivers,
 * per-connection negotiation) directly — a future SFU-backed transport can implement the same
 * contract without changing any caller.
 *
 * Every public method here is defensive against the participant already having been removed —
 * locally, or racing an async signaling step — and resolves/no-ops instead of throwing or
 * rejecting in that case. Genuine (non-race) negotiation failures are logged and still resolve
 * rather than reject, because a caller cannot meaningfully recover from a specific rejected
 * `handleRemote*` call; the connection's real health is observable through `peerStateChanged`
 * transitioning to `'failed'`, which is the WebRTC-idiomatic signal for that.
 */
export class P2PMeshTransport implements MediaTransport {
  private readonly config: RtcTransportConfig;
  private readonly signalingPort: SignalingPort;
  private readonly createPeerConnection: (config: RtcTransportConfig) => RtcPeerConnectionLike;

  private readonly peers = new Map<ParticipantId, Peer>();
  private readonly publishedTracks = new Set<MediaStreamTrack>();

  private readonly remoteTrackListeners = new Set<MediaTransportEvents['remoteTrack']>();
  private readonly localTrackMidListeners = new Set<MediaTransportEvents['localTrackMid']>();
  private readonly peerStateChangedListeners = new Set<MediaTransportEvents['peerStateChanged']>();
  private readonly peerClosedListeners = new Set<MediaTransportEvents['peerClosed']>();

  private closedAll = false;

  constructor(
    config: RtcTransportConfig,
    signalingPort: SignalingPort,
    options: P2PMeshTransportOptions = {},
  ) {
    this.config = config;
    this.signalingPort = signalingPort;
    this.createPeerConnection = options.createPeerConnection ?? createRtcPeerConnection;
  }

  addParticipant(participantId: ParticipantId, role: 'initiator' | 'responder'): void {
    if (this.closedAll || this.peers.has(participantId)) return;

    const pc = this.createPeerConnection(this.config);
    const peer = new Peer(participantId, role, pc, this.signalingPort, {
      onRemoteTrack: (track, stream, mid) => {
        for (const listener of [...this.remoteTrackListeners]) {
          listener({ participantId, track, stream, mid });
        }
      },
      onLocalTrackMid: (track, mid) => {
        for (const listener of [...this.localTrackMidListeners]) {
          listener({ participantId, track, mid });
        }
      },
      onStateChanged: (connectionState, iceConnectionState) => {
        for (const listener of [...this.peerStateChangedListeners]) {
          listener({ participantId, connectionState, iceConnectionState });
        }
      },
      onTerminal: () => this.cleanupPeer(participantId),
      onIceCandidate: (candidate) => {
        try {
          this.signalingPort.sendIceCandidate(participantId, candidate);
        } catch (error) {
          console.error(`rtc-core: signaling port failed sending an ICE candidate`, {
            participantId,
            error,
          });
        }
      },
    });

    this.peers.set(participantId, peer);
    for (const track of this.publishedTracks) peer.addTrack(track);

    if (role === 'initiator') {
      peer.createAndSendOffer().catch((error: unknown) => {
        if (peer.isClosed) return;
        console.error(`rtc-core: failed to create/send an offer`, { participantId, error });
      });
    }
  }

  removeParticipant(participantId: ParticipantId): void {
    this.cleanupPeer(participantId);
  }

  async handleRemoteOffer(participantId: ParticipantId, sdp: string): Promise<void> {
    const peer = this.peers.get(participantId);
    if (!peer) return;
    try {
      await peer.handleRemoteOffer(sdp);
    } catch (error) {
      console.error(`rtc-core: failed to handle a remote offer`, { participantId, error });
    }
  }

  async handleRemoteAnswer(participantId: ParticipantId, sdp: string): Promise<void> {
    const peer = this.peers.get(participantId);
    if (!peer) return;
    try {
      await peer.handleRemoteAnswer(sdp);
    } catch (error) {
      console.error(`rtc-core: failed to handle a remote answer`, { participantId, error });
    }
  }

  async handleRemoteIceCandidate(
    participantId: ParticipantId,
    candidate: RTCIceCandidateInit | null,
  ): Promise<void> {
    const peer = this.peers.get(participantId);
    if (!peer) return;
    try {
      await peer.handleRemoteIceCandidate(candidate);
    } catch (error) {
      console.error(`rtc-core: failed to apply a remote ICE candidate`, { participantId, error });
    }
  }

  publishTrack(track: MediaStreamTrack): void {
    if (this.publishedTracks.has(track)) return;
    this.publishedTracks.add(track);
    for (const peer of this.peers.values()) peer.addTrack(track);
  }

  unpublishTrack(track: MediaStreamTrack): void {
    if (!this.publishedTracks.delete(track)) return;
    for (const peer of this.peers.values()) peer.removeTrack(track);
  }

  /**
   * T11: swaps an already-published track's content in place across every current peer — see
   * `MediaTransport.replaceTrack` (`types.ts`) for the full contract. Updates `publishedTracks` so a
   * peer added *after* this call is seeded with `newTrack`, not the stale `oldTrack`, exactly the
   * same "future peers see current state" guarantee `publishTrack`/`unpublishTrack` already give.
   *
   * `oldTrack` not being a currently published track at all is treated as a caller bug (mirroring
   * `Peer.replaceTrack`'s own contract) — `replaceTrack` has no legitimate "hasn't arrived yet" race
   * to swallow silently, unlike this transport's async `handleRemote*` methods.
   *
   * A single already-connected peer lacking a sender for `oldTrack` (a real, if rare, per-peer mesh
   * timing quirk — e.g. that peer connection is mid-teardown, or its own `addParticipant` seeding
   * raced this call in a narrow window) is handled defensively: `Peer.replaceTrack` throws for that
   * peer specifically, and this method catches and logs it rather than letting one peer's bookkeeping
   * gap abort replacement for every other, healthy peer in the mesh.
   */
  replaceTrack(oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack): void {
    if (!this.publishedTracks.has(oldTrack)) {
      throw new Error(
        `rtc-core: P2PMeshTransport.replaceTrack called for a track that was never published — ` +
          `publishTrack(oldTrack) must be called before replaceTrack(oldTrack, newTrack)`,
      );
    }
    this.publishedTracks.delete(oldTrack);
    this.publishedTracks.add(newTrack);
    for (const peer of this.peers.values()) {
      try {
        peer.replaceTrack(oldTrack, newTrack);
      } catch (error) {
        console.error(`rtc-core: replaceTrack failed for one peer, continuing for the rest`, {
          error,
        });
      }
    }
  }

  async getStats(participantId: ParticipantId): Promise<RTCStatsReport | undefined> {
    const peer = this.peers.get(participantId);
    if (!peer) return undefined;
    return peer.getStats();
  }

  on<K extends keyof MediaTransportEvents>(event: K, listener: MediaTransportEvents[K]): void {
    this.listenersFor(event).add(listener);
  }

  off<K extends keyof MediaTransportEvents>(event: K, listener: MediaTransportEvents[K]): void {
    this.listenersFor(event).delete(listener);
  }

  closeAll(): void {
    if (this.closedAll) return;
    this.closedAll = true;
    for (const [participantId, peer] of [...this.peers]) {
      this.peers.delete(participantId);
      peer.close();
      this.emitPeerClosed(participantId);
    }
    this.publishedTracks.clear();
  }

  private cleanupPeer(participantId: ParticipantId): void {
    const peer = this.peers.get(participantId);
    if (!peer) return;
    this.peers.delete(participantId);
    peer.close();
    this.emitPeerClosed(participantId);
  }

  private emitPeerClosed(participantId: ParticipantId): void {
    for (const listener of [...this.peerClosedListeners]) listener(participantId);
  }

  private listenersFor<K extends keyof MediaTransportEvents>(
    event: K,
  ): Set<MediaTransportEvents[K]> {
    switch (event) {
      case 'remoteTrack':
        return this.remoteTrackListeners as Set<MediaTransportEvents[K]>;
      case 'localTrackMid':
        return this.localTrackMidListeners as Set<MediaTransportEvents[K]>;
      case 'peerStateChanged':
        return this.peerStateChangedListeners as Set<MediaTransportEvents[K]>;
      case 'peerClosed':
        return this.peerClosedListeners as Set<MediaTransportEvents[K]>;
      default:
        throw new Error(`rtc-core: unknown MediaTransport event "${String(event)}"`);
    }
  }
}
