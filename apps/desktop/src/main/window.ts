import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';

import { buildContentSecurityPolicy } from './content-security-policy.js';
import { registerIpcHandlers } from './ipc.js';
import { installNavigationGuards } from './navigation-guards.js';
import { allowedRendererOrigins } from './origins.js';
import { appEntryUrl } from './protocol.js';
import { buildWindowOptions } from './window-options.js';

function devServerUrl(): string | undefined {
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

export function createMainWindow(): BrowserWindow {
  const devServer = devServerUrl();
  const preloadPath = path.join(__dirname, 'preload.cjs');

  const window = new BrowserWindow(
    buildWindowOptions(preloadPath, { devToolsEnabled: !app.isPackaged }),
  );

  const allowedOrigins = allowedRendererOrigins(devServer);
  installNavigationGuards(window.webContents, allowedOrigins);
  registerIpcHandlers(window.webContents, allowedOrigins);

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
