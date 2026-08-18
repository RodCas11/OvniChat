export const APP_PROTOCOL_SCHEME = 'app';
export const APP_PROTOCOL_HOST = 'renderer';
export const APP_ORIGIN = `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}`;

/**
 * `URL#origin` is only meaningful for the WHATWG "special" schemes (http, https, ws, wss, ftp,
 * file); Node's URL parser treats a custom scheme like `app:` as non-special and reports its
 * origin as the literal string `"null"`. This computes a scheme+host origin manually so the
 * `app://renderer` production origin compares correctly, both here and at Electron runtime.
 */
function computeOrigin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/**
 * The single origin the Renderer is ever allowed to be at: the packaged `app://` document in
 * production, or the Vite dev server origin in development. Navigation, window-open, and IPC
 * sender checks all resolve against this same allowlist.
 */
export function allowedRendererOrigins(devServerUrl?: string): readonly string[] {
  if (!devServerUrl) return [APP_ORIGIN];
  try {
    return [computeOrigin(new URL(devServerUrl))];
  } catch {
    return [APP_ORIGIN];
  }
}

export function isAllowedOrigin(url: string, allowedOrigins: readonly string[]): boolean {
  try {
    return allowedOrigins.includes(computeOrigin(new URL(url)));
  } catch {
    return false;
  }
}
