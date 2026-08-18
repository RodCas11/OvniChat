import { net, protocol } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildContentSecurityPolicy } from './content-security-policy.js';
import { APP_PROTOCOL_HOST, APP_PROTOCOL_SCHEME } from './origins.js';

export function registerAppProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
}

export function appEntryUrl(): string {
  return `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/index.html`;
}

/**
 * Maps a requested `app://renderer/...` URL to a file inside `rendererDir`, rejecting any host
 * other than the expected one and any path that would traverse outside `rendererDir`. Pure and
 * Electron-free so path-traversal denial is directly unit-testable.
 */
export function resolveRendererFilePath(rendererDir: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  if (url.protocol !== `${APP_PROTOCOL_SCHEME}:` || url.hostname !== APP_PROTOCOL_HOST) {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  const relative = pathname === '' || pathname === '/' ? '/index.html' : pathname;
  const rendererRoot = path.normalize(rendererDir);
  const resolved = path.normalize(path.join(rendererRoot, relative));

  if (resolved !== rendererRoot && !resolved.startsWith(rendererRoot + path.sep)) {
    return null;
  }

  return resolved;
}

export function registerAppProtocolHandler(rendererDir: string, realtimeOrigin: string): void {
  protocol.handle(APP_PROTOCOL_SCHEME, async (request) => {
    const filePath = resolveRendererFilePath(rendererDir, request.url);
    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }

    const fileResponse = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(fileResponse.headers);
    headers.set('Content-Security-Policy', buildContentSecurityPolicy({ realtimeOrigin }));
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(fileResponse.body, {
      status: fileResponse.status,
      headers,
    });
  });
}
