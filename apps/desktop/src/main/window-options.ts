import type { BrowserWindowConstructorOptions } from 'electron';

export interface WindowOptionOverrides {
  readonly devToolsEnabled: boolean;
  /** T13.5 — absolute path to the Chantivo `.ico`, resolved by the caller (dev vs packaged differ —
   * see `window.ts`'s own `resolveChantivoIconPath`). `undefined` is a safe no-op (Electron falls
   * back to its own default icon), never a crash — this is a cosmetic nicety, not the release-blocking
   * mechanism (that's `forge.config.ts`'s `packagerConfig.icon`, which embeds the icon into the
   * packaged executable resource directly, independent of this at runtime). */
  readonly iconPath?: string | undefined;
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
    // T13.5 — an explicit initial title avoids a flash of Electron's own default title before
    // `index.html`'s `<title>Chantivo</title>` loads; both now agree.
    title: 'Chantivo',
    ...(overrides.iconPath !== undefined ? { icon: overrides.iconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: overrides.devToolsEnabled,
      spellcheck: false,
      // A real-time voice/video call must keep decoding and rendering remote media at full rate
      // even when this window is occluded or not the OS-focused window (e.g. the other party's
      // window is on top, or the app is in the background) — Chromium's default background
      // throttling (reduced timer/rAF/requestVideoFrameCallback rate for non-visible/unfocused
      // content) is meant for ordinary background tabs, not an active call. Live-measured during
      // T5 stabilization: running two Electron instances side by side, the non-focused instance's
      // remote video decode/frame-callback rate dropped enough to miss an 8s frame-delta proof
      // window entirely, while the focused instance passed the same check quickly every time —
      // disabling this resolved it.
      backgroundThrottling: false,
    },
  };
}
