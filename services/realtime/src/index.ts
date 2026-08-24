/**
 * Public library surface of `@disco-voador/realtime` — the reusable realtime transport/session
 * implementation. Deliberately side-effect-free: importing this module must never start a server
 * or read `process.env` (see `cli.ts` for that, the package's own dev/test CLI entrypoint).
 * `services/dedicated-server` composes `createRealtimeServer` from here into the actual Disco
 * Voador Dedicated Server product — see `docs/architecture/DEDICATED_SERVER.md`.
 */
export {
  createRealtimeServer,
  type RealtimeServerAddress,
  type RealtimeServerDependencies,
  type RealtimeServerHandle,
} from './server.js';
export { loadRealtimeConfig, type RealtimeConfig } from './config.js';
export { DEFAULT_VOICE_CHANNELS } from './voice/catalog.js';
export { createLogger, createNoopLogger, type Logger } from './logging.js';
export {
  createNoopAuthorizationPort,
  type AdmissionResult,
  type AuthorizationPort,
  type AuthorizationSnapshot,
  type BanResult,
  type CreateGroupResult,
  type CreateTokenResult,
  type DeleteGroupResult,
  type GrantGroupResult,
  type ListGroupsResult,
  type RedeemTokenResult,
  type RevokeGroupResult,
  type UnbanResult,
  type UpdateGroupResult,
} from './authorization-port.js';
export {
  createNoopChatPort,
  type ChatHistoryPage,
  type ChatPort,
  type SendChatMessageResult,
} from './chat-port.js';
export {
  createNoopChannelPort,
  type CanJoinResult,
  type ChannelPort,
  type ChannelTreeSnapshot,
  type CreateNodeResult,
  type DeleteNodeResult,
  type MoveNodeResult,
  type ReorderResult,
  type SetPasswordResult,
  type UpdateNodeResult,
} from './channel-port.js';
export {
  maybeDestroyEmptyTemporaryChannel,
  TemporaryChannelRegistry,
  type TemporaryChannelRecord,
} from './voice/temporary-channels.js';
export { VoiceRegistry } from './voice/registry.js';
export {
  createNoopProfilePort,
  type AvatarData,
  type ProfilePort,
  type ProfileSnapshot,
  type SetAvatarResult,
} from './profile-port.js';
export {
  PresenceRegistry,
  type DeregisterConnectionResult,
  type RegisterConnectionResult,
} from './presence/registry.js';
export { deriveMemberRoleBucket } from './presence/role-bucket.js';
export {
  createNoopTurnCredentialPort,
  type MintedTurnCredentials,
  type TurnCredentialIceServer,
  type TurnCredentialPort,
} from './turn-credential-port.js';
