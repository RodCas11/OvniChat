export interface ContentSecurityPolicyOptions {
  /** Present only in development, where the Vite dev server serves the document directly. */
  readonly devServerOrigin?: string;
}

/**
 * Builds a restrictive Content Security Policy. Development needs one documented relaxation:
 * `@vitejs/plugin-react` injects an inline `<script type="module">` preamble to wire up React
 * Fast Refresh, which requires `'unsafe-inline'` on `script-src`. That relaxation never ships —
 * production documents are served from the `app://` protocol with no dev server origin, so the
 * strict branch below applies to every packaged build.
 *
 * `connect-src` allows the `ws:`/`wss:` schemes generically rather than one pre-declared origin
 * (T2–T7's design). T8 made the realtime server address a runtime, user-typed value
 * (`ConnectionScreen`) — the entire point of the Dedicated Server product boundary is that a client
 * connects to whichever address its operator gives it, which cannot be known before the page loads
 * and so cannot be pre-declared as one exact CSP origin the way T2–T7's single implicit development
 * server could. Every other directive stays maximally restrictive (`default-src`/`script-src`
 * `'self'` only, no `https:`/`http:` in `connect-src`), so this scopes the necessarily-dynamic
 * target down to exactly one channel — a WebSocket connection — rather than opening arbitrary
 * network access; a compromised Renderer already gains this capability from the product's own
 * connect-to-any-address feature, not from a CSP gap. See
 * `docs/architecture/DEDICATED_SERVER.md`'s "Client connection UX" section.
 */
export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions = {}): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", 'ws:', 'wss:'],
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
