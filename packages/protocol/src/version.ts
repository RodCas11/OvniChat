/**
 * The realtime wire protocol version. A connection negotiates exactly one version during the
 * handshake (`client:hello` / `server:hello`); it is not repeated on every subsequent message,
 * since a WebSocket connection's protocol version cannot change mid-connection — there is nothing
 * for later messages to renegotiate.
 *
 * Evolution strategy: additive, backward-compatible changes (new message types, new optional
 * fields) do not require a version bump. A breaking change (removing/renaming a field, changing a
 * field's meaning, tightening a constraint an existing client relies on) requires incrementing
 * `CURRENT_PROTOCOL_VERSION` and adding the new value to `SUPPORTED_PROTOCOL_VERSIONS`. The server
 * may support more than one version at once during a migration window; a client that requests a
 * version outside `SUPPORTED_PROTOCOL_VERSIONS` receives `UNSUPPORTED_PROTOCOL` and the connection
 * is closed — this is a defined failure, not undefined behavior.
 *
 * Bumped to 2 for T7: `client:hello` gained required `nickname`/`publicKey` fields and the
 * handshake gained a mandatory identity-challenge/proof step before `server:hello`. This is a
 * breaking change (an old client's hello is no longer sufficient to reach `ready`), so v1 support
 * was dropped rather than kept as a parallel unauthenticated codepath — maintaining it would have
 * meant either bypassing identity verification for v1 clients (unacceptable) or having v1 always
 * fail (pointless to keep as "support").
 *
 * Bumped to 3 for T8: `server:hello` gained required `serverName`/`serverCapabilities` fields (the
 * Dedicated Server product's minimal self-description — see
 * `docs/architecture/DEDICATED_SERVER.md`). Both `client:hello` and `server:hello` are validated
 * with `.strict()` schemas on the receiving side, so a new *required* field is a breaking shape
 * change for whichever side didn't expect it yet, even though nothing about identity verification
 * or existing fields' meaning changed — treated the same as T7's bump for consistency.
 *
 * **Not bumped for T9** (server-local authorization — see
 * `docs/architecture/SERVER_AUTHORIZATION.md`), deliberately: every T9 wire change is genuinely
 * additive under the policy above — `client:hello` gained only an *optional* `serverToken` field,
 * `voice:join`'s participant shape gained only an *optional* `groups` badge array, and every new
 * authorization concept (group/token/ban management, the authorization-state snapshot) is an
 * entirely new message type added to the existing discriminated unions, never a change to an
 * existing message's required shape. This is the first task to actually exercise the "new message
 * types, new optional fields" half of the evolution policy rather than the "required field" half
 * T7 and T8 both needed.
 *
 * Bumped to 4 for T13.2 (channels & server administration): `voice:catalog` changed shape from a
 * flat `channels: VoiceChannelSummary[]` to a per-connection-filtered `nodes: ChannelNodeView[]`
 * tree, with no parallel old field kept alongside it — an old client's `.strict()` parser would
 * reject the new shape outright (`channels` is gone), so this is a genuine breaking change, not an
 * additive one, exactly like T7's v1->v2 bump. v3 support was dropped rather than kept as a
 * parallel codepath, matching that same precedent.
 *
 * **Not bumped for T13.3** (profiles/avatars/members/presence), deliberately, for the same reason
 * T9 was not bumped: every T13.3 wire change is genuinely additive under the policy above —
 * `server:hello` gained only an *optional* `serverAvatarRef` field, `permissionKeySchema` gained
 * only a new key (`moderation.profile.clear`) an unrecognized-key-tolerant client already handles
 * safely, `errorCodeSchema` gained only new codes a client already falls back on generically for,
 * and every new profile/presence concept (`client:profile-*`/`server:profile-*`/
 * `server:presence-*`) is an entirely new message type added to the existing discriminated unions,
 * never a change to an existing message's required shape.
 *
 * Bumped to 5 for the T13.4 local-voice-preference-persistence targeted fix: `voiceParticipantSchema`
 * (`voice:joined.participants[]`, `voice:participant-joined.participant`) gained a required
 * `identityRef` field — a durable, per-server correlation token letting a client's local volume/
 * "Mute for Me" preference survive a peer's reconnect (see
 * `docs/adr/0022-durable-per-server-identity-ref-for-local-voice-preferences.md`). Deliberately
 * *not* made optional the way T9's `groups` was: `identityRef` only has value if a consumer can rely
 * on it always being present, and the server has no scenario where it cannot compute one (unlike
 * `groups`, genuinely absent for a server with no authorization store at all). An old client's
 * `.strict()` parser would reject the new, larger participant shape outright, and a new client
 * talking to an old server would find `identityRef` missing from a shape it now requires — a real
 * breaking change either direction, exactly like T7/T8/T13.2's own required-field bumps, not an
 * additive one. v4 support was dropped rather than kept as a parallel codepath, matching that same
 * precedent.
 *
 * Still v5 (no further bump) for the T13.4 UI-consistency follow-up: `voiceParticipantSchema` also
 * gained a required `memberRef` field, letting a client correlate a voice participant with the same
 * `memberRef`-keyed `server:presence-updated`/`memberPresenceSchema` entry Member Panel already
 * reads `avatarRef` from — the "smallest safe bridge" for live voice-participant avatars, reusing an
 * identifier already broadcast server-wide (ADR-worthy for `identityRef` above; not for `memberRef`,
 * since `memberRef` introduces no new exposure, only a new *use* of an existing one). Shape-wise this
 * is exactly as breaking as `identityRef`'s own addition (another required field on the same
 * `.strict()` schema), but since v5 had not yet shipped/been committed when this field was added,
 * both fields ship together under the one v5 bump rather than forcing a v6 for a version that never
 * existed in the wild.
 */
export const CURRENT_PROTOCOL_VERSION = 5;

export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [5];

export function isSupportedProtocolVersion(version: number): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}
