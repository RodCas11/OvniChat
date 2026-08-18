import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { installPermissionHandlers } from '../../apps/desktop/src/main/permissions.js';

describe('installPermissionHandlers', () => {
  it('denies every permission check unconditionally', () => {
    let checkHandler: ((...args: unknown[]) => boolean) | undefined;
    const session = {
      setPermissionCheckHandler: (handler: typeof checkHandler) => {
        checkHandler = handler;
      },
      setPermissionRequestHandler: () => {},
    } as unknown as Session;

    installPermissionHandlers(session);

    expect(checkHandler?.(null, 'media', 'https://example.com', {})).toBe(false);
    expect(checkHandler?.(null, 'display-capture', 'app://renderer', {})).toBe(false);
  });

  it('denies every permission request unconditionally', () => {
    let requestHandler:
      | ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void)
      | undefined;
    const session = {
      setPermissionCheckHandler: () => {},
      setPermissionRequestHandler: (handler: typeof requestHandler) => {
        requestHandler = handler;
      },
    } as unknown as Session;

    installPermissionHandlers(session);

    const callback = vi.fn();
    requestHandler?.(null, 'media', callback);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(false);
  });
});
