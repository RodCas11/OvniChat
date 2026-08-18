import type { Event, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { installNavigationGuards } from '../../apps/desktop/src/main/navigation-guards.js';

type WillNavigateListener = (event: Event, url: string) => void;
type WindowOpenHandler = (details: { url: string }) => { action: 'allow' | 'deny' };

function createFakeWebContents(): {
  webContents: WebContents;
  emitWillNavigate: (url: string) => Event;
  windowOpenHandler: () => WindowOpenHandler;
} {
  let willNavigateListener: WillNavigateListener | undefined;
  let windowOpenHandler: WindowOpenHandler | undefined;

  const webContents = {
    on: (channel: string, listener: WillNavigateListener) => {
      if (channel === 'will-navigate') willNavigateListener = listener;
    },
    setWindowOpenHandler: (handler: WindowOpenHandler) => {
      windowOpenHandler = handler;
    },
  } as unknown as WebContents;

  return {
    webContents,
    emitWillNavigate(url: string) {
      const event = { preventDefault: vi.fn() } as unknown as Event;
      willNavigateListener?.(event, url);
      return event;
    },
    windowOpenHandler: () => {
      if (!windowOpenHandler) throw new Error('setWindowOpenHandler was never called');
      return windowOpenHandler;
    },
  };
}

describe('installNavigationGuards', () => {
  const allowedOrigins = ['app://renderer'];

  it('allows navigation within the allowed origin', () => {
    const { webContents, emitWillNavigate } = createFakeWebContents();
    installNavigationGuards(webContents, allowedOrigins);

    const event = emitWillNavigate('app://renderer/index.html');

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('denies navigation to an external origin', () => {
    const { webContents, emitWillNavigate } = createFakeWebContents();
    installNavigationGuards(webContents, allowedOrigins);

    const event = emitWillNavigate('https://evil.example/');

    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('denies every window-open request', () => {
    const { webContents, windowOpenHandler } = createFakeWebContents();
    installNavigationGuards(webContents, allowedOrigins);

    expect(windowOpenHandler()({ url: 'https://anything.example/' })).toEqual({
      action: 'deny',
    });
  });
});
