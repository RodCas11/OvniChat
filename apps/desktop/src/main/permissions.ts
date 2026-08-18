import type { Session } from 'electron';

/**
 * T1 ships no feature that needs any Electron permission, so both handlers default-deny
 * unconditionally. A later task that adds a real capability (e.g. display capture) must extend
 * this with an explicit origin/frame/permission-kind allowlist rather than relaxing it broadly.
 */
export function installPermissionHandlers(session: Session): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}
