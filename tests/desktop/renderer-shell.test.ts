import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from '../../apps/desktop/src/renderer/App.js';

describe('App shell', () => {
  it('renders the foundation-only shell without a preload bridge available', () => {
    // Server-side rendering never runs effects, so this exercises the shell's initial render
    // (before any `window.desktopApp` call) without needing a DOM or a mocked bridge.
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('Projeto Disco Voador');
    expect(markup).toContain('Desktop client foundation');
    expect(markup).toContain('T1 Electron Shell');
    expect(markup).toContain('Starting');
  });

  it('states that product capabilities remain unimplemented', () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('Voice, microphone, camera, screen sharing');
    expect(markup).toContain('Text chat');
  });
});
