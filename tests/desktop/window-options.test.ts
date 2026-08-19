import { describe, expect, it } from 'vitest';

import { buildWindowOptions } from '../../apps/desktop/src/main/window-options.js';

describe('buildWindowOptions', () => {
  it('asserts the required Electron security preferences', () => {
    const options = buildWindowOptions('/preload.cjs', { devToolsEnabled: false });

    expect(options.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
    });
  });

  it('wires the given preload script path', () => {
    const options = buildWindowOptions('/some/preload.cjs', { devToolsEnabled: true });

    expect(options.webPreferences?.preload).toBe('/some/preload.cjs');
    expect(options.webPreferences?.devTools).toBe(true);
  });

  it('does not show the window before it is ready to render', () => {
    const options = buildWindowOptions('/preload.cjs', { devToolsEnabled: false });

    expect(options.show).toBe(false);
  });

  it('disables background throttling so remote call media keeps decoding at full rate when unfocused', () => {
    const options = buildWindowOptions('/preload.cjs', { devToolsEnabled: false });

    expect(options.webPreferences?.backgroundThrottling).toBe(false);
  });
});
