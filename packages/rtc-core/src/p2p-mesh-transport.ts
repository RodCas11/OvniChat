import { toRtcIceServers } from './ice-servers.js';
import { Peer } from './peer.js';
import { createRtcPeerConnection, type RtcPeerConnectionLike } from './rtc-peer-connection.js';
import type {
  MediaTransport,
  MediaTransportEvents,
  ParticipantId,
  RtcIceServerConfig,
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
 *
 * T15.2 note on the `'failed'` lifecycle: a peer reaching `'failed'` is no longer removed from the
 * mesh on the spot. `Peer` first runs its own bounded ICE-restart recovery (see that class), and
 * only reports terminal — at which point `cleanupPeer` closes and removes it, emitting `peerClosed`
 * exactly as before — once that budget is spent. Keeping the peer in `peers` for the duration is
 * load-bearing, not incidental: it is what lets an ICE-restart offer from the *remote* side of the
 * pair still be routed to a connection that has failed locally.
 */
export class P2PMeshTransport implements MediaTransport {
  /**
   * Mutable — unlike every other field below — specifically so {@link setIceServers} can apply
   * late-arriving TURN credentials (T14's `server:turn-credentials` protocol message, which cannot
   * arrive before this transport is constructed: it is only pushed after a successful identity
   * handshake) without forcing a caller to discard and recreate this transport just to pick up a
   * new ICE server list. `addParticipant` always reads this field lazily at the moment it creates a
   * new `RTCPeerConnection`, so a `setIceServers` call made any time before a given
   * `addParticipant` call is fully honored by that call — and, since T15.1, a `setIceServers` call
   * made *after* one is honored too, for any peer that has not yet established a working transport
   * (see {@link setIceServers}).
   */
  private config: RtcTransportConfig;
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

  /**
   * T14 — replaces the ICE server list used to construct every `RTCPeerConnection` created by a
   * subsequent {@link addParticipant} call. This exists so a caller can apply TURN credentials that
   * only become available *after* this transport is already constructed (they arrive over the
   * realtime service's `server:turn-credentials` message, sent once after a successful identity
   * handshake — see `packages/protocol/src/messages/turn.ts`) without discarding and recreating the
   * transport, which would also drop every already-connected peer.
   *
   * This is deliberately declared on `P2PMeshTransport` itself, not on the shared `MediaTransport`
   * interface (`types.ts`): dynamically updating a live ICE server list is a P2P-mesh-specific
   * accommodation for TURN credentials that expire and get reminted (ADR 0006's SFU-ready seam only
   * commits a future SFU-backed transport to the same *participant/media* contract, not to this
   * exact mechanism — an SFU transport's relay path is typically the SFU server itself, not a
   * per-peer TURN server applied this way).
   *
   * REPLACE semantics, not merge: this call takes over the *entire* `iceServers` array, discarding
   * whatever was supplied to the constructor or a previous `setIceServers` call — it does not retain
   * a separate "original STUN servers" list to merge new servers into. A caller that wants to keep
   * its original STUN servers *and* add newly-received TURN servers must pass the already-merged
   * list itself, e.g. `transport.setIceServers([...stunServers, ...turnServers])`. This mirrors the
   * platform's own `RTCConfiguration.iceServers`, which is always a full replacement, never a merge,
   * and keeps this method's behavior unsurprising: passing `[]` (TURN not configured — a fully
   * supported self-hosted deployment per `docs/PRODUCT.md`) is an entirely ordinary case with no
   * special-cased behavior, producing the same STUN/host-only connectivity as if no ICE servers had
   * ever been configured.
   *
   * ## T15.1 — self-healing for peers created before this call
   *
   * This originally only affected `RTCPeerConnection`s created *after* the call, on the (incorrect)
   * assumption that the platform cannot change a live connection's ICE servers. It can:
   * `RTCPeerConnection.setConfiguration()` is standard, supported WebRTC, and pairing it with
   * `restartIce()` makes an already-created connection genuinely re-gather against the new list.
   *
   * That assumption produced a real, field-reproduced dead end: any peer connection created while
   * the ICE server list was still empty (or still pointed at an endpoint that turned out to be
   * unreachable) stayed limited to host candidates for the entire session, with no mechanism able to
   * repair it. So this call now *also* pushes the new list into every existing peer that has not yet
   * established a working transport (see `Peer.applyIceServers`/`Peer.hasEstablishedTransport`).
   *
   * Peers that already have a working transport are deliberately left completely untouched — no
   * `setConfiguration`, no ICE restart, no renegotiation. A routine credential refresh must never
   * disturb a call that is currently working; only a connection that has not managed to connect yet
   * has anything to gain from re-gathering. Since T15.2 those untouched peers do still *remember*
   * the new list (see `Peer.applyIceServers`), so that if one of them later fails, its bounded
   * ICE-restart recovery re-gathers against the newest credentials rather than the possibly-expired
   * ones its connection was constructed with.
   */
  setIceServers(iceServers: readonly RtcIceServerConfig[]): void {
    this.config = { ...this.config, iceServers };
    if (this.closedAll) return;

    const platformIceServers = toRtcIceServers(this.config);
    for (const [participantId, peer] of this.peers) {
      try {
        peer.applyIceServers(platformIceServers);
      } catch (error) {
        // One peer rejecting the new configuration (e.g. it is mid-teardown and the platform throws
        // `InvalidStateError`) must never prevent every other peer in the mesh from being healed.
        console.error(`rtc-core: failed to apply new ICE servers to an existing peer`, {
          participantId,
          error,
        });
      }
    }
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
