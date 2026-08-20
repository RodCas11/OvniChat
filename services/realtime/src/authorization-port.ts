import type {
  GroupBadge,
  GroupSummary,
  BanSummary,
  PermissionKey,
  TokenKind,
} from '@disco-voador/protocol';

/**
 * T9 — the narrow, synchronous seam `services/realtime` depends on for server-local authorization,
 * mirroring exactly how T8 injected `voiceChannels`/`serverMetadata`: this package defines the
 * contract and a permissive default; `services/dedicated-server` provides the real, SQLite-backed
 * implementation (`SqliteAuthorizationPort`) via composition. `services/realtime` itself never
 * knows about groups/tokens/bans as *concepts* beyond this interface — it only calls these methods
 * at the exact points authorization must gate something (admission, voice-channel join, and the
 * `client:authorization-*` message handlers), and only ever passes through whatever the port
 * returns.
 *
 * Every method is **synchronous** — deliberately. `Connection`/`routeClientMessage` are a fully
 * synchronous hot path (see `protocol-handlers.ts`'s doc comment); a synchronous port lets the
 * exact single-threaded-event-loop guarantee that already makes voice-channel join/leave atomic
 * also make token redemption atomic, with no manual locking and no async rewrite of the connection
 * state machine. See `docs/architecture/SERVER_AUTHORIZATION.md` for the full design and the
 * accepted tradeoff (synchronous disk I/O on the shared event loop per connecting identity).
 *
 * No method here ever accepts a client-supplied `identityId` for anything other than the calling
 * connection's own, already-server-verified identity, or an explicit administrator-facing
 * ban/unban target (see `docs/tasks/T9_SERVER_AUTHORIZATION.md` Section 37) — every other target is
 * always a `participantId`, resolved to a connection/identity by `services/realtime` itself
 * (`VoiceRegistry`) before ever reaching the port.
 */

export type AdmissionResult =
  | {
      readonly ok: true;
      readonly groups: readonly GroupBadge[];
      readonly permissions: readonly PermissionKey[];
    }
  | { readonly ok: false; readonly code: 'BANNED' | 'INVITE_REQUIRED'; readonly message: string };

export type RedeemTokenResult =
  | { readonly ok: true; readonly group: GroupBadge }
  | {
      readonly ok: false;
      readonly code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED' | 'TOKEN_ALREADY_USED';
      readonly message: string;
    };

export type CreateTokenResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly tokenKind: TokenKind;
      readonly groupId: string;
      readonly expiresAt: number | undefined;
    }
  | { readonly ok: false; readonly code: 'GROUP_NOT_FOUND'; readonly message: string };

export type ListGroupsResult = readonly GroupSummary[];

export type CreateGroupResult =
  | { readonly ok: true; readonly group: GroupSummary }
  | { readonly ok: false; readonly code: 'GROUP_NOT_FOUND'; readonly message: string };

export type UpdateGroupResult =
  | { readonly ok: true; readonly group: GroupSummary }
  | {
      readonly ok: false;
      readonly code: 'GROUP_NOT_FOUND' | 'PROTECTED_GROUP';
      readonly message: string;
    };

export type DeleteGroupResult =
  | {
      readonly ok: true;
      /** Identities left with no remaining admission basis under `accessMode: invite-only` because
       * this was their sole persistent membership (T9 Section 63/follow-up) — mirrors
       * `RevokeGroupResult`'s `stillAdmitted` symmetry. Always empty when `accessMode === 'open'`. */
      readonly noLongerAdmitted: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: 'GROUP_NOT_FOUND' | 'PROTECTED_GROUP';
      readonly message: string;
    };

export type GrantGroupResult =
  | { readonly ok: true; readonly snapshot: AuthorizationSnapshot }
  | { readonly ok: false; readonly code: 'GROUP_NOT_FOUND'; readonly message: string };

export type RevokeGroupResult =
  | { readonly ok: true; readonly snapshot: AuthorizationSnapshot; readonly stillAdmitted: boolean }
  | {
      readonly ok: false;
      readonly code: 'GROUP_NOT_FOUND' | 'LAST_ADMIN';
      readonly message: string;
    };

export type BanResult = { readonly ok: true };

export type UnbanResult = { readonly ok: true; readonly wasBanned: boolean };

export interface AuthorizationSnapshot {
  readonly groups: readonly GroupBadge[];
  readonly permissions: readonly PermissionKey[];
}

export interface AuthorizationPort {
  /** Evaluated once, synchronously, right after identity-proof verification succeeds and before
   * the connection can ever reach `ready` (see `protocol-handlers.ts`'s `handleIdentityProof`). */
  admit(request: {
    readonly identityId: string;
    readonly nickname: string;
    readonly serverToken: string | undefined;
  }): AdmissionResult;

  /** `true` iff the identity currently holds a group carrying `permission`. Never throws for an
   * unknown identity — an identity with no persistent membership evaluates against its effective
   * Guest baseline, the same as {@link admit}. */
  can(identityId: string, permission: PermissionKey): boolean;

  /** The identity's own current groups/permissions — used to (re-)send `server:authorization-state`. */
  getSnapshot(identityId: string): AuthorizationSnapshot;

  /** Display-only group badges for a *different* identity, shown to other participants
   * (`voice:joined`/`voice:participant-joined`). Never includes permissions or any
   * identity-correlating data beyond the badge's own group name. */
  getPublicBadges(identityId: string): readonly GroupBadge[];

  /** Redeems a bearer token (privilege or invite) for the *caller's own* identity — used by
   * `client:authorization-redeem-token`, always from `ready` (non-fatal on failure). */
  redeemToken(identityId: string, token: string): RedeemTokenResult;

  /** `actorIdentityId` must already hold `authorization.tokens.manage`; enforced by the caller in
   * `protocol-handlers.ts` before this is ever invoked — this method only performs the mutation. */
  createToken(params: {
    readonly tokenKind: TokenKind;
    readonly groupId: string;
    readonly expiresInMs: number | undefined;
  }): CreateTokenResult;

  listGroups(): ListGroupsResult;
  createGroup(params: {
    readonly name: string;
    readonly permissions: readonly PermissionKey[];
  }): CreateGroupResult;
  updateGroup(params: {
    readonly groupId: string;
    readonly name: string | undefined;
    readonly permissions: readonly PermissionKey[] | undefined;
  }): UpdateGroupResult;
  deleteGroup(groupId: string): DeleteGroupResult;

  /** `targetIdentityId` is always server-resolved from a `participantId` by the caller — never a
   * client-supplied value (see this file's own doc comment). */
  grantGroup(targetIdentityId: string, groupId: string): GrantGroupResult;
  /** `stillAdmitted` is `false` only when revoking this group leaves an `accessMode: invite-only`
   * identity with no remaining persistent membership at all — the caller uses this to decide
   * whether to also close that identity's live connection (T9 Section 63). */
  revokeGroup(targetIdentityId: string, groupId: string): RevokeGroupResult;

  ban(
    targetIdentityId: string,
    durationMs: number | undefined,
    reason: string | undefined,
  ): BanResult;
  unban(identityId: string): UnbanResult;
  listBans(): readonly BanSummary[];

  /** Releases any held resources (e.g. closes the underlying database handle). */
  close(): void;
}

const EMPTY_BADGES: readonly GroupBadge[] = [];
const EMPTY_PERMISSIONS: readonly PermissionKey[] = [];

/**
 * The default `AuthorizationPort` for any `@disco-voador/realtime` consumer that doesn't compose
 * its own (this package's own dev CLI, `tests/realtime/*`) — admits every identity unconditionally
 * with no groups/permissions/bans, preserving pre-T9 behavior exactly. `services/dedicated-server`
 * always supplies `SqliteAuthorizationPort` instead; this is never used in a real product deployment.
 */
export function createNoopAuthorizationPort(): AuthorizationPort {
  return {
    admit: () => ({ ok: true, groups: EMPTY_BADGES, permissions: EMPTY_PERMISSIONS }),
    can: () => true,
    getSnapshot: () => ({ groups: EMPTY_BADGES, permissions: EMPTY_PERMISSIONS }),
    getPublicBadges: () => EMPTY_BADGES,
    redeemToken: () => ({
      ok: false,
      code: 'TOKEN_INVALID',
      message: 'No authorization store configured',
    }),
    createToken: () => ({
      ok: false,
      code: 'GROUP_NOT_FOUND',
      message: 'No authorization store configured',
    }),
    listGroups: () => [],
    createGroup: () => ({
      ok: false,
      code: 'GROUP_NOT_FOUND',
      message: 'No authorization store configured',
    }),
    updateGroup: () => ({
      ok: false,
      code: 'GROUP_NOT_FOUND',
      message: 'No authorization store configured',
    }),
    deleteGroup: () => ({
      ok: false,
      code: 'GROUP_NOT_FOUND',
      message: 'No authorization store configured',
    }),
    grantGroup: () => ({
      ok: false,
      code: 'GROUP_NOT_FOUND',
      message: 'No authorization store configured',
    }),
    revokeGroup: () => ({
      ok: false,
      code: 'GROUP_NOT_FOUND',
      message: 'No authorization store configured',
    }),
    ban: () => ({ ok: true }),
    unban: () => ({ ok: true, wasBanned: false }),
    listBans: () => [],
    close: () => {},
  };
}
