import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { appEntryUrl, resolveRendererFilePath } from '../../apps/desktop/src/main/protocol.js';

const rendererDir = path.join('C:', 'app', '.vite', 'renderer', 'main_window');

describe('resolveRendererFilePath', () => {
  it('resolves the entry document', () => {
    expect(resolveRendererFilePath(rendererDir, 'app://renderer/index.html')).toBe(
      path.join(rendererDir, 'index.html'),
    );
  });

  it('defaults an empty path to index.html', () => {
    expect(resolveRendererFilePath(rendererDir, 'app://renderer/')).toBe(
      path.join(rendererDir, 'index.html'),
    );
  });

  it('resolves nested asset paths', () => {
    expect(resolveRendererFilePath(rendererDir, 'app://renderer/assets/index-abc123.js')).toBe(
      path.join(rendererDir, 'assets', 'index-abc123.js'),
    );
  });

  it('neutralizes forward-slash dot-segments during URL parsing itself', () => {
    // The WHATWG URL parser removes ".." path segments while constructing `pathname`, so this
    // never reaches our own containment check as raw "..": it resolves safely inside the
    // renderer directory rather than escaping it.
    const resolved = resolveRendererFilePath(
      rendererDir,
      'app://renderer/../../../../Windows/System32/x',
    );
    expect(resolved).toBe(path.join(rendererDir, 'Windows', 'System32', 'x'));
    expect(resolved?.startsWith(rendererDir)).toBe(true);
  });

  it('neutralizes percent-encoded dot-segments during URL parsing itself', () => {
    const resolved = resolveRendererFilePath(
      rendererDir,
      'app://renderer/%2e%2e/%2e%2e/secret.txt',
    );
    expect(resolved).toBe(path.join(rendererDir, 'secret.txt'));
    expect(resolved?.startsWith(rendererDir)).toBe(true);
  });

  it('rejects a backslash path-traversal attempt that survives URL parsing unnormalized', () => {
    // Unlike "/", the WHATWG URL parser does not treat "\" as a segment separator for a
    // non-special scheme, so ".." segments written with backslashes reach us unresolved. This is
    // exactly what the explicit containment check (not just URL parsing) exists to catch.
    const traversal = 'app://renderer/' + '..\\'.repeat(4) + 'Windows\\System32\\x';
    expect(resolveRendererFilePath(rendererDir, traversal)).toBeNull();
  });

  it('rejects a malformed percent-escape instead of throwing', () => {
    // The URL constructor accepts this (it doesn't validate percent-encoding correctness), but
    // `decodeURIComponent` throws a URIError on it. That must resolve to `null`, not propagate.
    expect(resolveRendererFilePath(rendererDir, 'app://renderer/%E0%A4%A')).toBeNull();
  });

  it('rejects an unexpected scheme', () => {
    expect(resolveRendererFilePath(rendererDir, 'https://evil.example/index.html')).toBeNull();
  });

  it('rejects an unexpected host on the app scheme', () => {
    expect(resolveRendererFilePath(rendererDir, 'app://other-host/index.html')).toBeNull();
  });
});

describe('appEntryUrl', () => {
  it('points at the renderer document root', () => {
    expect(appEntryUrl()).toBe('app://renderer/index.html');
  });
});
