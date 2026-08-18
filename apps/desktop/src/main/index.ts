import { app, BrowserWindow, Menu, session } from 'electron';
import path from 'node:path';

import { installPermissionHandlers } from './permissions.js';
import { registerAppProtocolHandler, registerAppProtocolPrivileges } from './protocol.js';
import { createMainWindow } from './window.js';

// Must run before `app` becomes ready.
registerAppProtocolPrivileges();

const isSmokeTest = process.env['DISCO_VOADOR_SMOKE_TEST'] === '1';

function rendererDirectory(): string {
  return path.join(__dirname, '../renderer', MAIN_WINDOW_VITE_NAME);
}

function armSmokeTestExit(window: BrowserWindow): void {
  if (!isSmokeTest) return;

  const timeout = setTimeout(() => {
    console.error('SMOKE_TIMEOUT: renderer did not finish loading in time');
    app.exit(1);
  }, 15_000);

  window.webContents.once('did-finish-load', () => {
    clearTimeout(timeout);
    console.info('SMOKE_OK');
    setTimeout(() => app.exit(0), 250);
  });

  window.webContents.once('did-fail-load', () => {
    clearTimeout(timeout);
    console.error('SMOKE_LOAD_FAILED');
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // T1 has no product use for a native menu, and `autoHideMenuBar` only hides it visually — Alt
  // would still reveal Electron's default menu (including reload/DevTools items) without this.
  Menu.setApplicationMenu(null);

  registerAppProtocolHandler(rendererDirectory());
  installPermissionHandlers(session.defaultSession);

  const window = createMainWindow();
  armSmokeTestExit(window);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

bootstrap().catch((error: unknown) => {
  console.error('Disco Voador desktop shell failed to start', error);
  app.exit(1);
});
