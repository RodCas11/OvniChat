export interface ContentSecurityPolicyOptions {
  /** Present only in development, where the Vite dev server serves the document directly. */
  readonly devServerOrigin?: string;
  /**
   * The exactly-one realtime WebSocket origin this build is configured to connect to (see
   * `desktop-config.ts`), added to `connect-src` explicitly — never a wildcard scheme/host, so a
   * compromised Renderer cannot open a WebSocket to an arbitrary attacker-chosen endpoint.
   */
  readonly realtimeOrigin: string;
}

/**
 * Builds a restrictive Content Security Policy. Development needs one documented relaxation:
 * `@vitejs/plugin-react` injects an inline `<script type="module">` preamble to wire up React
 * Fast Refresh, which requires `'unsafe-inline'` on `script-src`. That relaxation never ships —
 * production documents are served from the `app://` protocol with no dev server origin, so the
 * strict branch below applies to every packaged build.
 */
export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", options.realtimeOrigin],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  };

  if (options.devServerOrigin) {
    // Documented development-only exception: Vite HMR preamble + module graph.
    directives['script-src'] = ["'self'", "'unsafe-inline'"];
  }

  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}
