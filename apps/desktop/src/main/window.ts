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
    buildWindowOptions(preloadPath, { devToolsEnabled: !app.isPackaged }),
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
