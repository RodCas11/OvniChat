import type { Session } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hasPendingScreenShareSelectionMock = vi.fn(() => false);
vi.mock('../../apps/desktop/src/main/screen-share.js', () => ({
  hasPendingScreenShareSelection: hasPendingScreenShareSelectionMock,
}));

const { installPermissionHandlers } = await import('../../apps/desktop/src/main/permissions.js');

const ALLOWED_ORIGIN = 'app://renderer';
const allowedOrigins = [ALLOWED_ORIGIN];

beforeEach(() => {
  hasPendingScreenShareSelectionMock.mockReturnValue(false);
});

describe('installPermissionHandlers', () => {
  describe('permission checks', () => {
    function install(): (...args: unknown[]) => boolean {
      let checkHandler: ((...args: unknown[]) => boolean) | undefined;
      const session = {
        setPermissionCheckHandler: (handler: typeof checkHandler) => {
          checkHandler = handler;
        },
        setPermissionRequestHandler: () => {},
      } as unknown as Session;

      installPermissionHandlers(session, allowedOrigins);
      if (!checkHandler) throw new Error('check handler was not installed');
      return checkHandler;
    }

    it('allows audio-only media from the allowed origin', () => {
      const checkHandler = install();
      expect(checkHandler(null, 'media', ALLOWED_ORIGIN, { mediaType: 'audio' })).toBe(true);
    });

    it('denies media from an origin outside the allowlist', () => {
      const checkHandler = install();
      expect(checkHandler(null, 'media', 'https://evil.example', { mediaType: 'audio' })).toBe(
        false,
      );
    });

    it('allows video-only media from the allowed origin', () => {
      const checkHandler = install();
      expect(checkHandler(null, 'media', ALLOWED_ORIGIN, { mediaType: 'video' })).toBe(true);
    });

    it('denies unknown media type even from the allowed origin', () => {
      const checkHandler = install();
      expect(checkHandler(null, 'media', ALLOWED_ORIGIN, { mediaType: 'unknown' })).toBe(false);
    });

    it('denies every non-media permission unconditionally', () => {
      const checkHandler = install();
      expect(checkHandler(null, 'display-capture', ALLOWED_ORIGIN, {})).toBe(false);
      expect(checkHandler(null, 'geolocation', ALLOWED_ORIGIN, {})).toBe(false);
    });
  });

  describe('permission requests', () => {
    function install(): (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: unknown,
    ) => void {
      let requestHandler:
        | ((
            webContents: unknown,
            permission: string,
            callback: (granted: boolean) => void,
            details: unknown,
          ) => void)
        | undefined;
      const session = {
        setPermissionCheckHandler: () => {},
        setPermissionRequestHandler: (handler: typeof requestHandler) => {
          requestHandler = handler;
        },
      } as unknown as Session;

      installPermissionHandlers(session, allowedOrigins);
      if (!requestHandler) throw new Error('request handler was not installed');
      return requestHandler;
    }

    it('grants an audio-only request from the allowed origin', () => {
      const requestHandler = install();
      const callback = vi.fn();

      requestHandler(null, 'media', callback, {
        requestingUrl: ALLOWED_ORIGIN,
        mediaTypes: ['audio'],
      });

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(true);
    });

    it('grants a video-only request from the allowed origin', () => {
      const requestHandler = install();
      const callback = vi.fn();

      requestHandler(null, 'media', callback, {
        requestingUrl: ALLOWED_ORIGIN,
        mediaTypes: ['video'],
      });

      expect(callback).toHaveBeenCalledWith(true);
    });

    it('denies a request that includes video alongside audio', () => {
      const requestHandler = install();
      const callback = vi.fn();

      requestHandler(null, 'media', callback, {
        requestingUrl: ALLOWED_ORIGIN,
        mediaTypes: ['audio', 'video'],
      });

      expect(callback).toHaveBeenCalledWith(false);
    });

    it('grants a getDisplayMedia()-shaped request (empty mediaTypes) from the allowed origin when a source is armed', () => {
      // A real `getDisplayMedia()` call reaches this handler as `permission === 'media'` with an
      // *empty* `mediaTypes` array — see `isDisplayCaptureRequest`'s doc comment in
      // `main/permissions.ts` for the Electron-source-level research behind this. Per a security
      // review's follow-up, this also requires a currently-armed `screen-share.ts` selection
      // (this app's own sanctioned flow always arms one via `selectScreenShareSource` immediately
      // before calling `getDisplayMedia()`) — granting this permission only lets the request
      // continue to `screen-share.ts`'s own (default-deny) `setDisplayMediaRequestHandler` gate.
      hasPendingScreenShareSelectionMock.mockReturnValue(true);
      const requestHandler = install();
      const callback = vi.fn();

      requestHandler(null, 'media', callback, {
        requestingUrl: ALLOWED_ORIGIN,
        mediaTypes: [],
      });

      expect(callback).toHaveBeenCalledWith(true);
    });

    it('denies a getDisplayMedia()-shaped request when no source is currently armed', () => {
      // Covers both a genuinely stray/direct call and the documented legacy `chromeMediaSource:
      // 'screen'` bypass this handler cannot otherwise distinguish from a real `getDisplayMedia()`
      // call — see `isDisplayCaptureRequest`'s doc comment.
      hasPendingScreenShareSelectionMock.mockReturnValue(false);
      const requestHandler = install();
      const callback = vi.fn();

      requestHandler(null, 'media', callback, {
        requestingUrl: ALLOWED_ORIGIN,
        mediaTypes: [],
      });

      expect(callback).toHaveBeenCalledWith(false);
    });

    it('denies a getDisplayMedia()-shaped request from an origin outside the allowlist even when a source is armed', () => {
      hasPendingScreenShareSelectionMock.mockReturnValue(true);
      const requestHandler = install();
      const callback = vi.fn();

      requestHandler(null, 'media', callback, {
        requestingUrl: 'https://evil.example',
        mediaTypes: [],
      });

      expect(callback).toHaveBeenCalledWith(false);
    });

    it('denies a media request from an origin outside the allowlist', () => {
      const requestHandler = install();
      const callback = vi.fn();

      requestHandler(null, 'media', callback, {
        requestingUrl: 'https://evil.example',
        mediaTypes: ['audio'],
      });

      expect(callback).toHaveBeenCalledWith(false);
    });

    it('denies every non-media permission request unconditionally', () => {
      const requestHandler = install();
      const callback = vi.fn();

      requestHandler(null, 'display-capture', callback, { requestingUrl: ALLOWED_ORIGIN });

      expect(callback).toHaveBeenCalledWith(false);
    });
  });
});
