import { describe, expect, it } from 'vitest';

import {
  deviceIdConstraint,
  resolveDeviceFallback,
} from '../../apps/desktop/src/renderer/voice/use-voice-channel.js';

/**
 * T11 — direct unit coverage for `use-voice-channel.ts`'s device-switching pure logic (fallback
 * detection and the `exactOptionalPropertyTypes`-safe constraint builder), mirroring
 * `use-voice-channel-chat.test.ts`'s established precedent for this file's pure helpers.
 */

describe('resolveDeviceFallback', () => {
  it('is never a fallback when no preference was set (system default was the intent)', () => {
    expect(resolveDeviceFallback(null, undefined)).toBe(false);
    expect(resolveDeviceFallback(null, 'whatever-device-id')).toBe(false);
  });

  it('is not a fallback when the actual device matches the preferred device', () => {
    expect(resolveDeviceFallback('device-1', 'device-1')).toBe(false);
  });

  it('is a fallback when the actual device does not match the preferred device', () => {
    expect(resolveDeviceFallback('device-1', 'device-2')).toBe(true);
  });

  it('is a fallback when a preference was set but the actual device is unknown/undefined', () => {
    expect(resolveDeviceFallback('device-1', undefined)).toBe(true);
  });
});

describe('deviceIdConstraint', () => {
  it('omits the deviceId key entirely for "system default" (null) rather than assigning undefined', () => {
    const result = deviceIdConstraint(null);
    expect(result).toEqual({});
    expect('deviceId' in result).toBe(false);
  });

  it('includes a concrete deviceId when a preference is set', () => {
    expect(deviceIdConstraint('device-1')).toEqual({ deviceId: 'device-1' });
  });
});
