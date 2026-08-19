import type { Session } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeNativeImage {
  isEmpty(): boolean;
  toDataURL(): string;
}

interface FakeSource {
  id: string;
  name: string;
  thumbnail: FakeNativeImage;
  appIcon: FakeNativeImage;
  display_id: string;
}

const emptyImage: FakeNativeImage = { isEmpty: () => true, toDataURL: () => '' };

function fakeImage(dataUrl: string): FakeNativeImage {
  return { isEmpty: () => false, toDataURL: () => dataUrl };
}

interface GetSourcesOptions {
  types: string[];
  thumbnailSize: { width: number; height: number };
  fetchWindowIcons?: boolean;
}

let nextSources: FakeSource[] = [];
const getSources = vi.fn<(options: GetSourcesOptions) => Promise<FakeSource[]>>(
  async () => nextSources,
);

vi.mock('electron', () => ({
  desktopCapturer: { getSources },
}));

const { installScreenShareHandlers, listScreenShareSources, selectScreenShareSource } =
  await import('../../apps/desktop/src/main/screen-share.js');

const ALLOWED_ORIGIN = 'app://renderer';

type DisplayMediaHandler = (
  request: { securityOrigin: string; audioRequested?: boolean },
  callback: (streams: unknown) => void,
) => void;

/** Runs `fn` with `process.platform` temporarily overridden, restoring the real value afterward —
 * `screen-share.ts`'s Windows-only loopback gate must be exercised deterministically regardless of
 * which OS actually runs this test suite. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

function fakeSession(): { session: Session; getHandler: () => DisplayMediaHandler } {
  let handler: DisplayMediaHandler | undefined;
  const session = {
    setDisplayMediaRequestHandler: (fn: DisplayMediaHandler) => {
      handler = fn;
    },
  } as unknown as Session;
  return {
    session,
    getHandler: () => {
      if (!handler) throw new Error('display media handler was not installed');
      return handler;
    },
  };
}

beforeEach(() => {
  nextSources = [
    {
      id: 'screen:0:0',
      name: 'Entire Screen',
      thumbnail: fakeImage('data:image/png;base64,screen-thumb'),
      appIcon: emptyImage,
      display_id: '1',
    },
    {
      id: 'window:1234:0',
      name: 'Some App — a document.txt',
      thumbnail: fakeImage('data:image/png;base64,window-thumb'),
      appIcon: fakeImage('data:image/png;base64,window-icon'),
      display_id: '',
    },
  ];
  getSources.mockClear();
});

describe('listScreenShareSources', () => {
  it('returns only sanitized plain data, never a native object', async () => {
    const result = await listScreenShareSources();

    expect(result).toEqual([
      {
        id: 'screen:0:0',
        name: 'Entire Screen',
        type: 'screen',
        thumbnailDataUrl: 'data:image/png;base64,screen-thumb',
        appIconDataUrl: undefined,
        displayId: '1',
      },
      {
        id: 'window:1234:0',
        name: 'Some App — a document.txt',
        type: 'window',
        thumbnailDataUrl: 'data:image/png;base64,window-thumb',
        appIconDataUrl: 'data:image/png;base64,window-icon',
        displayId: undefined,
      },
    ]);
    // Every field on every returned object is a plain string or `undefined` — no function, class
    // instance, or other non-JSON-safe value is reachable from the result.
    for (const source of result) {
      for (const value of Object.values(source)) {
        expect(['string', 'undefined']).toContain(typeof value);
      }
    }
  });

  it('requests a bounded thumbnail size, never full resolution', async () => {
    await listScreenShareSources();

    const call = getSources.mock.calls[0]?.[0];
    expect(call?.types).toEqual(['screen', 'window']);
    expect(call?.thumbnailSize.width).toBeLessThanOrEqual(640);
    expect(call?.thumbnailSize.height).toBeLessThanOrEqual(480);
  });
});

// This block deliberately runs before `selectScreenShareSource`'s own describe block below, and
// its first test deliberately runs before any test anywhere in this file successfully arms a
// pending selection — `pendingSelection` is module-private state with no test-only reset, exactly
// like `ipc.test.ts`'s already-established "handlers is intentionally not reset between tests"
// pattern, so test order here is load-bearing, not incidental.
describe('installScreenShareHandlers / setDisplayMediaRequestHandler', () => {
  it('denies a getDisplayMedia() call with no prior selectScreenShareSource', async () => {
    await listScreenShareSources();
    const { session, getHandler } = fakeSession();
    installScreenShareHandlers(session, [ALLOWED_ORIGIN]);

    const callback = vi.fn();
    getHandler()({ securityOrigin: ALLOWED_ORIGIN }, callback);

    expect(callback).toHaveBeenCalledWith(undefined);
  });

  it('grants the real native source for a valid pending selection, audio-less by default', async () => {
    await listScreenShareSources();
    expect(selectScreenShareSource('screen:0:0', false)).toBe(true);

    const { session, getHandler } = fakeSession();
    installScreenShareHandlers(session, [ALLOWED_ORIGIN]);

    const callback = vi.fn();
    getHandler()({ securityOrigin: ALLOWED_ORIGIN, audioRequested: false }, callback);

    expect(callback).toHaveBeenCalledWith({ video: { id: 'screen:0:0', name: 'Entire Screen' } });
    const streams = callback.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('audio' in streams).toBe(false);
  });

  it('is single-use: a second getDisplayMedia() call cannot reuse the same approved selection', async () => {
    await listScreenShareSources();
    expect(selectScreenShareSource('screen:0:0', false)).toBe(true);

    const { session, getHandler } = fakeSession();
    installScreenShareHandlers(session, [ALLOWED_ORIGIN]);
    const handler = getHandler();

    const firstCallback = vi.fn();
    handler({ securityOrigin: ALLOWED_ORIGIN }, firstCallback);
    expect(firstCallback).toHaveBeenCalledWith({
      video: { id: 'screen:0:0', name: 'Entire Screen' },
    });

    const secondCallback = vi.fn();
    handler({ securityOrigin: ALLOWED_ORIGIN }, secondCallback);
    expect(secondCallback).toHaveBeenCalledWith(undefined);
  });

  it('denies even a valid pending selection from an unexpected origin', async () => {
    await listScreenShareSources();
    expect(selectScreenShareSource('screen:0:0', false)).toBe(true);

    const { session, getHandler } = fakeSession();
    installScreenShareHandlers(session, [ALLOWED_ORIGIN]);

    const callback = vi.fn();
    getHandler()({ securityOrigin: 'https://evil.example' }, callback);

    expect(callback).toHaveBeenCalledWith(undefined);
  });
});

describe('installScreenShareHandlers — T6 system audio (Windows loopback)', () => {
  it('grants audio: "loopback" when the armed selection, the getDisplayMedia call, and the platform all agree (win32)', async () => {
    await listScreenShareSources();
    expect(selectScreenShareSource('screen:0:0', true)).toBe(true);

    const { session, getHandler } = fakeSession();
    installScreenShareHandlers(session, [ALLOWED_ORIGIN]);

    const callback = vi.fn();
    withPlatform('win32', () => {
      getHandler()({ securityOrigin: ALLOWED_ORIGIN, audioRequested: true }, callback);
    });

    expect(callback).toHaveBeenCalledWith({
      video: { id: 'screen:0:0', name: 'Entire Screen' },
      audio: 'loopback',
    });
  });

  it('does not grant audio when the armed selection did not request it, even if the getDisplayMedia call did', async () => {
    await listScreenShareSources();
    expect(selectScreenShareSource('screen:0:0', false)).toBe(true);

    const { session, getHandler } = fakeSession();
    installScreenShareHandlers(session, [ALLOWED_ORIGIN]);

    const callback = vi.fn();
    withPlatform('win32', () => {
      getHandler()({ securityOrigin: ALLOWED_ORIGIN, audioRequested: true }, callback);
    });

    const streams = callback.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('audio' in streams).toBe(false);
  });

  it('does not grant audio when the armed selection requested it but the getDisplayMedia call itself did not', async () => {
    await listScreenShareSources();
    expect(selectScreenShareSource('screen:0:0', true)).toBe(true);

    const { session, getHandler } = fakeSession();
    installScreenShareHandlers(session, [ALLOWED_ORIGIN]);

    const callback = vi.fn();
    withPlatform('win32', () => {
      getHandler()({ securityOrigin: ALLOWED_ORIGIN, audioRequested: false }, callback);
    });

    const streams = callback.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('audio' in streams).toBe(false);
  });

  it('does not grant audio on a non-Windows platform even when everything else agrees', async () => {
    await listScreenShareSources();
    expect(selectScreenShareSource('screen:0:0', true)).toBe(true);

    const { session, getHandler } = fakeSession();
    installScreenShareHandlers(session, [ALLOWED_ORIGIN]);

    const callback = vi.fn();
    withPlatform('darwin', () => {
      getHandler()({ securityOrigin: ALLOWED_ORIGIN, audioRequested: true }, callback);
    });

    const streams = callback.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('audio' in streams).toBe(false);
  });
});

describe('selectScreenShareSource', () => {
  it('rejects an id that was never enumerated', async () => {
    await listScreenShareSources();
    expect(selectScreenShareSource('screen:99:0', false)).toBe(false);
  });

  it('rejects a stale id from a previous, now-superseded enumeration', async () => {
    await listScreenShareSources();
    expect(selectScreenShareSource('screen:0:0', false)).toBe(true);

    // A second, distinct enumeration supersedes the first — the old id must no longer validate.
    nextSources = [
      {
        id: 'screen:7:0',
        name: 'Entire Screen',
        thumbnail: emptyImage,
        appIcon: emptyImage,
        display_id: '',
      },
    ];
    await listScreenShareSources();
    expect(selectScreenShareSource('screen:0:0', false)).toBe(false);
  });

  it('accepts an id from the most recent enumeration', async () => {
    await listScreenShareSources();
    expect(selectScreenShareSource('window:1234:0', false)).toBe(true);
  });
});
