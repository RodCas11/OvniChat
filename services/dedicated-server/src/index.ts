/** Public library surface of `@disco-voador/dedicated-server` — used by its own tests/smoke
 * script and, if a future task needs it, another composition. `cli.ts` (the process entrypoint)
 * is not exported here, matching `@disco-voador/realtime`'s own index/cli split. */
export {
  createDedicatedServer,
  ensureDataDirExists,
  type DedicatedServerDependencies,
  type DedicatedServerHandle,
} from './create-dedicated-server.js';
export {
  DEFAULT_DATA_DIR,
  DEFAULT_SERVER_CONFIG_PATH,
  loadDedicatedServerConfig,
  type DedicatedServerConfig,
} from './config.js';
export {
  parseServerConfigFile,
  readServerConfigFile,
  ServerConfigFileError,
  type ServerConfigFile,
} from './server-config-file.js';
export {
  AuthorizationStore,
  ALL_PERMISSION_KEYS,
  BUILT_IN_GROUPS,
  GUEST_GROUP_ID,
  MEMBER_GROUP_ID,
  PROTECTED_GROUP_IDS,
  SERVER_ADMIN_GROUP_ID,
  digestServerToken,
  generateServerToken,
  type AccessMode,
  type AuthorizationStoreOptions,
  type BuiltInGroupSeed,
  type TokenPrefix,
} from './authorization/index.js';
export { ChatStore, CHAT_MIGRATIONS, type ChatStoreOptions } from './chat/index.js';
