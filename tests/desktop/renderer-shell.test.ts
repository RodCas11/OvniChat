import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from '../../apps/desktop/src/renderer/App.js';

describe('App shell', () => {
  // Server-side rendering never runs effects, so `useIdentity()` never resolves its
  // `window.desktopApp.getNickname()`/`getIdentity()` calls (and `window.desktopApp` itself is
  // unavailable in this SSR context anyway) — the component tree only ever observes the initial
  // `{ status: 'loading' }` state. T7's identity gate means the rest of the shell (bridge status,
  // voice section, capability list) is now reachable only once identity has loaded, which happens
  // client-side after mount — see `docs/tasks/T7_LOCAL_IDENTITY.md`'s "Known limitations" for why
  // that path has no automated component-level test in this repo (no jsdom/testing-library
  // dependency yet) and is instead verified manually per `docs/DEFINITION_OF_DONE.md`.
  it('renders a loading placeholder, not a crash, without a preload bridge available', () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('Projeto Disco Voador');
    expect(markup).toContain('Loading local identity');
  });

  it('does not render the main shell before identity has loaded', () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).not.toContain('Desktop client foundation');
    expect(markup).not.toContain('T1 Electron Shell');
    expect(markup).not.toContain('Voice');
    expect(markup).not.toContain('Camera and screen sharing');
  });
});
