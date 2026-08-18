export {};

/**
 * Ambient constants that Electron Forge's Vite plugin injects at build time via `define`. The
 * plugin ships this same declaration at `@electron-forge/plugin-vite/forge-vite-env.d.ts`, but a
 * `/// <reference types="..." />` to that subpath does not resolve reliably, so it is restated
 * here to match `getBuildDefine` in `@electron-forge/plugin-vite`.
 */
declare global {
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
}
