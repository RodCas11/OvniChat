import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';

import { buildContentSecurityPolicy } from './content-security-policy.js';
import type { DesktopConfig } from './desktop-config.js';
import { registerIpcHandlers } from './ipc.js';
import { installNavigationGuards } from './navigation-guards.js';
import { appEntryUrl } from './protocol.js';
import { buildWindowOptions } from './window-options.js';

export function devServerUrl(): string | undefined {
  return MAIN_WINDOW_VITE_DEV_SERVER_URL;
}

/**
 * T13.5 — resolves the Chantivo `.ico` for `BrowserWindow`'s own `icon` constructor option
 * (dev-mode/taskbar window icon — separate from the packaged executable's own embedded icon
 * resource, which `forge.config.ts`'s `packagerConfig.icon` sets independently). Packaged: reads
 * from `process.resourcesPath` (`forge.config.ts`'s `extraResource` copies it there). Unpackaged:
 * reads directly from this app's own `resources/` directory via `app.getAppPath()` (`electron
 * <desktopDir>` sets `app.getAppPath()` to `desktopDir` itself in dev). A missing file at either
 * path is not fatal — `buildWindowOptions` treats `undefined`/a bad path as a safe no-op, so this
 * never throws.
 */
function resolveChantivoIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'chantivo.ico')
    : path.join(app.getAppPath(), 'resources', 'chantivo.ico');
}

function installDevelopmentCsp(devServer: string): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildContentSecurityPolicy({ devServerOrigin: devServer })],
        'X-Content-Type-Options': ['nosniff'],
        'Referrer-Policy': ['no-referrer'],
      },
    });
  });
}

export function createMainWindow(
  config: DesktopConfig,
  allowedOrigins: readonly string[],
): BrowserWindow {
  const devServer = devServerUrl();
  const preloadPath = path.join(__dirname, 'preload.cjs');

  const window = new BrowserWindow(
    buildWindowOptions(preloadPath, {
      devToolsEnabled: !app.isPackaged,
      iconPath: resolveChantivoIconPath(),
    }),
  );

  installNavigationGuards(window.webContents, allowedOrigins);
  registerIpcHandlers(
    window.webContents,
    allowedOrigins,
    { url: config.realtimeUrl, iceServers: config.iceServers },
    // Packaged builds never expose this to the Renderer, regardless of environment variables —
    // the same `!app.isPackaged` gate used for the fake-media-device switches in `main/index.ts`.
    !app.isPackaged ? config.e2eVoiceAutoJoin : undefined,
    !app.isPackaged ? config.e2eSettingsPersistence : undefined,
    // T13.1 screenshot-capture tooling only — see `DesktopE2EScreenshotConfig`'s doc comment; same
    // `!app.isPackaged` gate as every other `DesktopE2E*Config` field above.
    !app.isPackaged ? config.e2eScreenshot : undefined,
  );

  window.once('ready-to-show', () => {
    window.show();
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('Renderer failed to load', { errorCode, errorDescription, validatedURL });
  });

  if (devServer) {
    installDevelopmentCsp(devServer);
    void window.loadURL(devServer);
  } else {
    void window.loadURL(appEntryUrl());
  }

  return window;
}
