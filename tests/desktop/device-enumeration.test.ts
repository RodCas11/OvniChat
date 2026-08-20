import { describe, expect, it } from 'vitest';

import {
  fallbackDeviceLabel,
  SYSTEM_DEFAULT_DEVICE,
  toEnumeratedDevices,
  withSystemDefault,
} from '../../apps/desktop/src/renderer/voice/device-enumeration.js';

/**
 * T11 — direct unit coverage for `device-enumeration.ts`'s pure device-list-shaping logic,
 * mirroring `use-voice-channel-chat.test.ts`'s precedent of testing hook-adjacent pure functions
 * directly rather than only through a live browser/E2E run.
 */

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return {
    kind,
    deviceId,
    label,
    groupId: `group-${deviceId}`,
    toJSON: () => ({ kind, deviceId, label }),
  } as MediaDeviceInfo;
}

describe('fallbackDeviceLabel', () => {
  it('numbers audio input devices starting at 1', () => {
    expect(fallbackDeviceLabel('audioinput', 0)).toBe('Microphone 1');
    expect(fallbackDeviceLabel('audioinput', 1)).toBe('Microphone 2');
  });

  it('numbers audio output devices as speakers', () => {
    expect(fallbackDeviceLabel('audiooutput', 0)).toBe('Speaker 1');
  });

  it('numbers video input devices as cameras', () => {
    expect(fallbackDeviceLabel('videoinput', 2)).toBe('Camera 3');
  });
});

describe('toEnumeratedDevices', () => {
  it('filters to only the requested kind', () => {
    const devices = [
      device('audioinput', 'mic-1', 'Real Mic'),
      device('videoinput', 'cam-1', 'Real Cam'),
      device('audiooutput', 'spk-1', 'Real Speaker'),
    ];

    expect(toEnumeratedDevices(devices, 'audioinput')).toEqual([
      { deviceId: 'mic-1', label: 'Real Mic' },
    ]);
  });

  it('substitutes a fallback label for a device with an empty label', () => {
    const devices = [device('audioinput', 'mic-1', ''), device('audioinput', 'mic-2', '')];

    expect(toEnumeratedDevices(devices, 'audioinput')).toEqual([
      { deviceId: 'mic-1', label: 'Microphone 1' },
      { deviceId: 'mic-2', label: 'Microphone 2' },
    ]);
  });

  it('never assumes labels are always populated — mixes real and fallback labels correctly', () => {
    const devices = [
      device('audioinput', 'mic-1', 'USB Headset'),
      device('audioinput', 'mic-2', ''),
    ];

    expect(toEnumeratedDevices(devices, 'audioinput')).toEqual([
      { deviceId: 'mic-1', label: 'USB Headset' },
      { deviceId: 'mic-2', label: 'Microphone 2' },
    ]);
  });

  it('returns an empty list when no device of that kind is present', () => {
    expect(toEnumeratedDevices([], 'videoinput')).toEqual([]);
  });
});

describe('withSystemDefault', () => {
  it('prepends the system-default pseudo-entry', () => {
    const devices = [{ deviceId: 'mic-1', label: 'USB Headset' }];
    expect(withSystemDefault(devices)).toEqual([SYSTEM_DEFAULT_DEVICE, ...devices]);
  });

  it('still prepends the system default for an empty list', () => {
    expect(withSystemDefault([])).toEqual([SYSTEM_DEFAULT_DEVICE]);
  });
});
