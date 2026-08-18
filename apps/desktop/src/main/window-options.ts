import type { BrowserWindowConstructorOptions } from 'electron';

export interface WindowOptionOverrides {
  readonly devToolsEnabled: boolean;
}

/**
 * Pure construction of the secure BrowserWindow options. Kept free of Electron runtime calls so
 * the security-relevant preferences can be asserted in unit tests without an Electron process.
 */
export function buildWindowOptions(
  preloadPath: string,
  overrides: WindowOptionOverrides,
): BrowserWindowConstructorOptions {
  return {
    width: 1024,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: overrides.devToolsEnabled,
      spellcheck: false,
    },
  };
}
