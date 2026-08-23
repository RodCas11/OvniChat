import { randomUUID } from 'node:crypto';

/**
 * T13.3 — authoritative, in-memory presence membership: which identities currently have >=1 live
 * connection, and a fresh, random, **online-session-scoped** `memberRef` token per identity.
 * Mirrors `VoiceRegistry`'s own construction exactly (a plain class, instantiated directly inside
 * `services/realtime` — never a `*Port`, never SQLite-backed, never injected from
 * `services/dedicated-server`) — presence membership is inherently live-connection state, the same
 * category of thing `VoiceRegistry` already owns, not persisted domain data.
 *
 * **Critical, non-negotiable security property**: {@link registerConnection} mints `memberRef` via
 * `randomUUID()` — never derived from `identityId` in any way (never a hash of it, never it
 * verbatim, never any deterministic function of it). See `packages/protocol/src/profile.ts`'s own
 * top doc comment for exactly why: `identityId` is stable *across independently-operated Dedicated
 * Servers* (ADR 0011 — the same local Ed25519 keypair derives the same `identityId` everywhere),
 * and this protocol has never sent it to another client for exactly that reason. A presence system
 * is a new, cross-voice-channel, server-wide broadcast surface; using `identityId` here would
 * silently reopen the exact correlation channel ADR 0011 closed.
 *
 * Multiple simultaneous connections for one identity are supported (nothing in this codebase
 * assumes one connection per identity — see `VoiceRegistry.findAllByIdentityId`'s own doc comment).
 * The nickname recorded for an identity is always its *most-recently-connected* live connection's
 * nickname (last-write-wins) — a documented, deliberate rule, not an oversight: presence has no
 * concept of "which of several simultaneous sessions is canonical," so the simplest, most-recent
 * value wins.
 */

export interface RegisterConnectionResult {
  /** The identity's current online-session `memberRef` — freshly minted if this is a 0->1
   * transition, otherwise the same value already in use for its other live connection(s). */
  readonly memberRef: string;
  /** `true` iff this connection is the identity's *first* live connection (0->1 transition). */
  readonly becameOnline: boolean;
}

export interface DeregisterConnectionResult {
  /** The `memberRef` this identity was using immediately before deregistration — always defined
   * for a connection that was actually registered. */
  readonly memberRef: string;
  /** `true` iff this was the identity's *last* live connection (1->0 transition) — the `memberRef`
   * is retired permanently the moment this is `true`; a later reconnect mints an entirely new one. */
  readonly becameOffline: boolean;
}

export class PresenceRegistry {
  private readonly connectionIdsByIdentity = new Map<string, Set<string>>();
  private readonly identityByConnectionId = new Map<string, string>();
  private readonly memberRefByIdentity = new Map<string, string>();
  private readonly nicknameByIdentity = new Map<string, string>();

  /** Called once a connection reaches `ready` for the first time. Idempotent per connection id —
   * calling it twice for the same `connectionId` without an intervening {@link deregisterConnection}
   * is a caller error (never happens in practice: `handleIdentityProof` is the only call site, and a
   * connection authenticates at most once), but is harmless either way (the `Set` dedupes). */
  registerConnection(
    identityId: string,
    connectionId: string,
    nickname: string,
  ): RegisterConnectionResult {
    let connectionIds = this.connectionIdsByIdentity.get(identityId);
    const becameOnline = !connectionIds || connectionIds.size === 0;
    if (!connectionIds) {
      connectionIds = new Set();
      this.connectionIdsByIdentity.set(identityId, connectionIds);
    }
    connectionIds.add(connectionId);
    this.identityByConnectionId.set(connectionId, identityId);
    // Last-write-wins, by design (see this file's own top doc comment) — always overwritten,
    // regardless of how many other live connections this identity already has.
    this.nicknameByIdentity.set(identityId, nickname);

    let memberRef = this.memberRefByIdentity.get(identityId);
    if (!memberRef) {
      memberRef = randomUUID();
      this.memberRefByIdentity.set(identityId, memberRef);
    }

    return { memberRef, becameOnline };
  }

  /** Called from connection-close cleanup, mirroring `VoiceRegistry.leave`'s "never waits for an
   * explicit leave message" guarantee. Returns `undefined` for a `connectionId` that was never
   * registered (e.g. a connection that disconnected before ever reaching `ready`). */
  deregisterConnection(connectionId: string): DeregisterConnectionResult | undefined {
    const identityId = this.identityByConnectionId.get(connectionId);
    if (!identityId) return undefined;
    this.identityByConnectionId.delete(connectionId);

    const memberRef = this.memberRefByIdentity.get(identityId);
    const connectionIds = this.connectionIdsByIdentity.get(identityId);
    connectionIds?.delete(connectionId);

    if (!memberRef) {
      // Invariant violated in practice this should never happen (a registered connectionId always
      // has a corresponding memberRef) — defensive only, never throws.
      return undefined;
    }

    const becameOffline = !connectionIds || connectionIds.size === 0;
    if (becameOffline) {
      this.connectionIdsByIdentity.delete(identityId);
      this.memberRefByIdentity.delete(identityId);
      this.nicknameByIdentity.delete(identityId);
    }

    return { memberRef, becameOffline };
  }

  isOnline(identityId: string): boolean {
    return (this.connectionIdsByIdentity.get(identityId)?.size ?? 0) > 0;
  }

  getMemberRef(identityId: string): string | undefined {
    return this.memberRefByIdentity.get(identityId);
  }

  getNickname(identityId: string): string | undefined {
    return this.nicknameByIdentity.get(identityId);
  }

  /** Resolves a client-supplied `memberRef` back to the identity it currently names — used only
   * server-side, to turn a `client:profile-*{target:'member', memberRef}` request into the actual
   * identity to act on. Never itself exposed on the wire; the caller (`protocol-handlers.ts`)
   * returns `MEMBER_NOT_FOUND` when this resolves to `undefined`. O(n) in the number of currently
   * online identities — acceptable at this codebase's scale (mirrors `VoiceRegistry
   * .findByParticipantId`'s identical linear-scan trade-off). */
  findIdentityByMemberRef(memberRef: string): string | undefined {
    for (const [identityId, ref] of this.memberRefByIdentity) {
      if (ref === memberRef) return identityId;
    }
    return undefined;
  }

  /** Every currently-online identity — used only to build the initial `server:presence-snapshot`. */
  listOnlineIdentityIds(): readonly string[] {
    return [...this.connectionIdsByIdentity.keys()];
  }
}
