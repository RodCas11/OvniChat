import type { WebContents } from 'electron';

import { isAllowedOrigin } from './origins.js';

/**
 * Denies navigation away from the allowed renderer origin and denies every window-open request.
 * T1 has no legitimate reason to navigate elsewhere or open a second window.
 */
export function installNavigationGuards(
  webContents: WebContents,
  allowedOrigins: readonly string[],
): void {
  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedOrigin(url, allowedOrigins)) {
      event.preventDefault();
    }
  });

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
