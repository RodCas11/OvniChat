import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from '../../apps/desktop/src/renderer/App.js';

describe('App shell', () => {
  // Server-side rendering never runs effects, so `useIdentity()` never resolves its
  // `window.desktopApp.getNickname()`/`getIdentity()` calls (and `window.desktopApp` itself is
  // unavailable in this SSR context anyway) — the component tree only ever observes the initial
  // `{ status: 'loading' }` state. T7's identity gate means the rest of the shell (`ServerHome`,
  // `AppShell`'s workspace) is now reachable only once identity has loaded, which happens
  // client-side after mount — see `docs/tasks/T7_LOCAL_IDENTITY.md`'s "Known limitations" for why
  // that path has no automated component-level test in this repo (no jsdom/testing-library
  // dependency yet) and is instead verified manually per `docs/DEFINITION_OF_DONE.md`.
  it('renders a loading placeholder, not a crash, without a preload bridge available', () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('OvniChat');
    expect(markup).toContain('Loading local identity');
  });

  // T13.1 — the pre-redesign strings this asserted against ("Desktop client foundation",
  // "T1 Electron Shell") no longer exist anywhere in the codebase; the redesigned equivalents
  // ("Server Chat", "Add Server", "Members —") are asserted here instead, so this test keeps
  // meaningfully proving the identity gate — not just that some now-nonexistent string is absent.
  it('does not render the connected workspace or server picker before identity has loaded', () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).not.toContain('Server Chat');
    expect(markup).not.toContain('Add Server');
    expect(markup).not.toContain('Members —');
    expect(markup).not.toContain('Voice & Video');
  });
});
