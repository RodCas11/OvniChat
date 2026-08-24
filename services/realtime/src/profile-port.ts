import { randomUUID } from 'node:crypto';

import type { AvatarImageFormat, AvatarRef, PresenceStatus } from '@disco-voador/protocol';

/**
 * T13.3 — the narrow, synchronous seam `services/realtime` depends on for genuinely *persistent*
 * profile state (avatar bytes/format/hash/revision, custom status text, manual presence
 * preference), mirroring exactly how T9/T10/T13.2 injected `AuthorizationPort`/`ChatPort`/
 * `ChannelPort`: this package defines the contract and a permissive default; `services/dedicated-
 * server` provides the real, SQLite-backed implementation (`SqliteProfileStore`,
 * `services/dedicated-server/src/profile/store.ts`) via composition.
 *
 * Deliberately owns **no** live-connection/session state at all — that is `PresenceRegistry`'s
 * concern (`services/realtime/src/presence/registry.ts`), a plain in-memory class, never a port.
 * This port never knows a `memberRef`, a nickname, or which identities are currently online; it
 * only ever stores/retrieves what would still be true if every connection dropped and the process
 * restarted. In particular, **no nickname is ever stored here** — nickname is sourced live from the
 * current connection via `PresenceRegistry`, exactly like `ChatPort.sendMessage` already sources a
 * message's nickname live rather than persisting it as a durable identity attribute.
 *
 * Every method is synchronous, for the same reason every other port here is (see
 * `authorization-port.ts`'s doc comment): `Connection`/`routeClientMessage` are a fully synchronous
 * hot path, and `node:sqlite`'s `DatabaseSync` is itself synchronous.
 *
 * Image validation (format sniffing, animated-format rejection, pixel-dimension ceilings) is
 * entirely this port's implementation's concern (`services/dedicated-server/src/profile/
 * image-validation.ts`) — `services/realtime` decodes the client's base64 payload into raw bytes and
 * passes them straight through, never inspecting image content itself (this package has no image-
 * processing dependency and must never need one).
 */

export interface ProfileSnapshot {
  readonly presencePreference: PresenceStatus;
  readonly customStatus: string | undefined;
  readonly avatarRef: AvatarRef | undefined;
}

export type SetAvatarResult =
  | { readonly ok: true; readonly avatarRef: AvatarRef }
  | {
      readonly ok: false;
      readonly code:
        | 'AVATAR_TOO_LARGE'
        | 'AVATAR_INVALID_FORMAT'
        | 'AVATAR_DIMENSIONS_TOO_LARGE'
        | 'AVATAR_ANIMATED_NOT_ALLOWED';
      readonly message: string;
    };

export interface AvatarData {
  readonly format: AvatarImageFormat;
  readonly bytes: Buffer;
  readonly avatarRef: AvatarRef;
}

export interface ProfilePort {
  /** Always returns a snapshot, even for an identity with no persisted row at all — a fresh
   * identity's implicit defaults (`presencePreference: 'online'`, no custom status, no avatar). */
  getUserProfile(identityId: string): ProfileSnapshot;

  /** The server's own singleton avatar, if any — `undefined` iff no server avatar is currently set. */
  getServerProfile(): { readonly avatarRef: AvatarRef | undefined };

  /** `rawBytes` is the already-base64-decoded image; validated (format sniff, animated-format
   * rejection, dimension ceiling), hashed, and persisted atomically. Replacing an existing avatar
   * deletes the old `avatar_assets` row in the same transaction (garbage-collected immediately, no
   * history/rollback — matches T13.2's channel-password precedent exactly). */
  setUserAvatar(identityId: string, format: AvatarImageFormat, rawBytes: Buffer): SetAvatarResult;
  clearUserAvatar(identityId: string): void;

  setServerAvatar(format: AvatarImageFormat, rawBytes: Buffer): SetAvatarResult;
  clearServerAvatar(): void;

  /** `undefined` clears; a defined value replaces (already validated/trimmed/bounded by
   * `customStatusSchema` before this is ever called). */
  setCustomStatus(identityId: string, customStatus: string | undefined): void;

  setPresencePreference(identityId: string, preference: PresenceStatus): void;

  /** `undefined` iff that identity currently has no avatar set. */
  getUserAvatarData(identityId: string): AvatarData | undefined;
  /** `undefined` iff the server currently has no avatar set. */
  getServerAvatarData(): AvatarData | undefined;

  /**
   * T13.4 — this identity's durable, per-server opaque correlation token (see
   * `@disco-voador/protocol`'s `identityRefSchema` for the full contract this must satisfy): the
   * same value every time this method is called for the same `identityId`, generated once on first
   * call and persisted forever after, and never derived from `identityId` in any recoverable way —
   * a fresh `randomUUID()`. Used only to populate `VoiceParticipant.identityRef`; never itself a
   * live-connection/session concept the way `memberRef` is (this port owns no session state — see
   * this file's own top doc comment).
   */
  getOrCreateIdentityRef(identityId: string): string;

  /** Releases any held resources (e.g. closes the underlying database handle). */
  close(): void;
}

const DEFAULT_SNAPSHOT: ProfileSnapshot = {
  presencePreference: 'online',
  customStatus: undefined,
  avatarRef: undefined,
};

/**
 * The default `ProfilePort` for any `@disco-voador/realtime` consumer that doesn't compose its own
 * (this package's own dev CLI, `tests/realtime/*`) — a genuinely functional, **non-persistent**,
 * in-memory implementation (mirroring `createNoopChannelPort`'s own "permissive, not just error
 * stubs" precedent, rather than `createNoopChatPort`'s "reject everything" one): avatar/status/
 * presence mutations actually take effect for the lifetime of the process, just never survive a
 * restart, and never enforce image-header/dimension validation (this package has no image-
 * processing dependency and never should — see this port's own doc comment). `services/dedicated-
 * server` always supplies `SqliteProfileStore` instead; this is never used in a real product
 * deployment.
 */
export function createNoopProfilePort(): ProfilePort {
  const userProfiles = new Map<string, ProfileSnapshot>();
  const userAvatarData = new Map<string, AvatarData>();
  const identityRefs = new Map<string, string>();
  let serverAvatarData: AvatarData | undefined;
  let nextRevision = 1;

  function getOrCreate(identityId: string): ProfileSnapshot {
    let snapshot = userProfiles.get(identityId);
    if (!snapshot) {
      snapshot = { ...DEFAULT_SNAPSHOT };
      userProfiles.set(identityId, snapshot);
    }
    return snapshot;
  }

  function fakeHash(rawBytes: Buffer): string {
    // Never used for anything security-relevant here (this port has no real image-validation
    // dependency to hash the actual content meaningfully) — just enough entropy to look like a
    // sha256 hex digest so `avatarRefSchema` validates it, derived from length + a counter so two
    // consecutive uploads never collide.
    const seed = `${String(rawBytes.length)}-${String(nextRevision)}`.padEnd(64, '0');
    return seed.slice(0, 64).replace(/[^0-9a-f]/gu, '0');
  }

  return {
    getUserProfile: (identityId) => getOrCreate(identityId),
    getServerProfile: () => ({ avatarRef: serverAvatarData?.avatarRef }),
    setUserAvatar: (identityId, format, rawBytes) => {
      const revision = nextRevision++;
      const avatarRef = { revision, hash: fakeHash(rawBytes) };
      userAvatarData.set(identityId, { format, bytes: rawBytes, avatarRef });
      userProfiles.set(identityId, { ...getOrCreate(identityId), avatarRef });
      return { ok: true, avatarRef };
    },
    clearUserAvatar: (identityId) => {
      userAvatarData.delete(identityId);
      userProfiles.set(identityId, { ...getOrCreate(identityId), avatarRef: undefined });
    },
    setServerAvatar: (format, rawBytes) => {
      const revision = nextRevision++;
      const avatarRef = { revision, hash: fakeHash(rawBytes) };
      serverAvatarData = { format, bytes: rawBytes, avatarRef };
      return { ok: true, avatarRef };
    },
    clearServerAvatar: () => {
      serverAvatarData = undefined;
    },
    setCustomStatus: (identityId, customStatus) => {
      userProfiles.set(identityId, { ...getOrCreate(identityId), customStatus });
    },
    setPresencePreference: (identityId, preference) => {
      userProfiles.set(identityId, { ...getOrCreate(identityId), presencePreference: preference });
    },
    getUserAvatarData: (identityId) => userAvatarData.get(identityId),
    getServerAvatarData: () => serverAvatarData,
    getOrCreateIdentityRef: (identityId) => {
      let ref = identityRefs.get(identityId);
      if (!ref) {
        ref = randomUUID();
        identityRefs.set(identityId, ref);
      }
      return ref;
    },
    close: () => {},
  };
}
