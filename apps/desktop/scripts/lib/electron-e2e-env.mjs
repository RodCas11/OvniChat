/**
 * Builds the environment for a spawned Electron E2E instance. `ELECTRON_RUN_AS_NODE` must be
 * genuinely *absent* from the child's environment, not merely falsy — Electron's native bootstrap
 * checks for the variable's presence (e.g. `getenv()`/`GetEnvironmentVariable()`) before any JS
 * ever runs, and an environment variable set to `''` still exists from the OS's point of view. On
 * at least one real Windows/Electron 43 combination, leaving it present-but-empty caused Electron
 * to attempt an inconsistent bootstrap path and abort with `Assertion failed:
 * (isolate_data->snapshot_data()) != nullptr` inside `node::CreateEnvironment` before any window
 * ever opened — a real, reproducible bug this function exists to prevent from recurring. This
 * matters here specifically because some shells/CI runners set `ELECTRON_RUN_AS_NODE=1` in the
 * *parent* environment (observed in at least one CI-like sandbox), which `{ ...baseEnv }` would
 * otherwise carry straight into the child.
 *
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {Record<string, string>} overrides
 * @returns {NodeJS.ProcessEnv}
 */
export function buildElectronE2EEnvironment(baseEnv, overrides) {
  const env = { ...baseEnv, ...overrides };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
