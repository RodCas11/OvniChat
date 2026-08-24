import { describe, expect, it, vi } from 'vitest';

import { NO_PTT_MODIFIERS, type PttBinding } from '../../packages/windows-media/src/ptt-binding.js';
import { startPttHotkeyListener } from '../../packages/windows-media/src/ptt-hotkey-listener.js';

/**
 * Separate file from `ptt-hotkey-listener.test.ts` because this one needs `uiohook-napi`'s module
 * factory to throw outright — simulating the real-world case this task's Requirement 6 targets: some
 * environment where the native module cannot load at all (e.g. no matching prebuild for the running
 * platform/arch, or a corrupted install), which `startPttHotkeyListener`'s dynamic
 * `import('uiohook-napi')` (see that module's own doc comment for why the import is dynamic, not
 * static) must turn into a typed failure result rather than an uncaught exception that could crash
 * the host process.
 */
vi.mock('uiohook-napi', () => {
  throw new Error('simulated missing prebuild for this platform/arch');
});

describe('startPttHotkeyListener — native module load failure', () => {
  it('surfaces a typed failure result rather than throwing or rejecting uncaught', async () => {
    const binding: PttBinding = { kind: 'keyboard', keycode: 0x2f, modifiers: NO_PTT_MODIFIERS };

    const result = await startPttHotkeyListener(binding, () => {
      throw new Error('onEvent must never be called when the listener never started');
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('native-module-load-failed');
    // Vitest wraps a `vi.mock` factory's own thrown error in its own diagnostic message rather than
    // re-throwing it verbatim, so this only asserts a real, non-empty diagnostic string reached the
    // typed failure result — never that `onEvent` was called, and never an uncaught throw/rejection,
    // which is this test's actual point.
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });
});
