import { useEffect, useState } from 'react';

/**
 * T11 — device enumeration for the Settings panel's microphone/camera/speaker dropdowns.
 * `navigator.mediaDevices.enumerateDevices()` is a standard Web API, already available in the
 * Renderer with no IPC involved (see `apps/desktop/src/renderer/voice/SettingsPanel.tsx`).
 *
 * Kept as plain, framework-light pure functions plus one hook — mirrors this codebase's existing
 * "extract the dedup/merge-shaped logic so it is directly unit-testable" precedent
 * (`remote-media-reconciliation.ts`, `use-voice-channel.ts`'s `mergeChatMessages`).
 */

/** One enumerated device, or the system-default pseudo-entry (`deviceId: null`) — matches
 * `settings-file.ts`'s own model of "`null` means use the platform's current system default",
 * distinct from any concrete `MediaDeviceInfo.deviceId`, which is never itself the string
 * `"default"`/empty in this app's own device lists (Chromium does use a `"default"` sentinel
 * deviceId for some platforms' first entry, but this module never depends on that being present —
 * it always prepends its own explicit system-default entry regardless of what Chromium enumerates). */
export interface EnumeratedDevice {
  readonly deviceId: string | null;
  readonly label: string;
}

export const SYSTEM_DEFAULT_DEVICE: EnumeratedDevice = { deviceId: null, label: 'System default' };

/**
 * Device *labels* are empty strings until the user has granted microphone/camera permission at
 * least once (a platform privacy protection, not a bug) — `enumerateDevices()` still returns the
 * right number of devices and real `deviceId`s, just with `label: ''`. This produces a stable,
 * numbered fallback label per kind so the dropdown is never blank, without ever guessing at the
 * device's real name.
 */
export function fallbackDeviceLabel(kind: MediaDeviceKind, indexAmongKind: number): string {
  const base = kind === 'audioinput' ? 'Microphone' : kind === 'audiooutput' ? 'Speaker' : 'Camera';
  return `${base} ${String(indexAmongKind + 1)}`;
}

/** Filters `devices` down to one `kind` and maps each to an {@link EnumeratedDevice}, substituting
 * {@link fallbackDeviceLabel} for any device whose `label` is empty. Never includes the
 * system-default pseudo-entry — see {@link withSystemDefault} for that. */
export function toEnumeratedDevices(
  devices: readonly MediaDeviceInfo[],
  kind: MediaDeviceKind,
): readonly EnumeratedDevice[] {
  const filtered = devices.filter((device) => device.kind === kind);
  return filtered.map((device, index) => ({
    deviceId: device.deviceId,
    label: device.label.trim().length > 0 ? device.label : fallbackDeviceLabel(kind, index),
  }));
}

/** Prepends the system-default pseudo-entry — every dropdown this module feeds always offers
 * "System default" first, distinct from any concrete device the platform enumerates. */
export function withSystemDefault(
  devices: readonly EnumeratedDevice[],
): readonly EnumeratedDevice[] {
  return [SYSTEM_DEFAULT_DEVICE, ...devices];
}

export interface MediaDeviceLists {
  readonly audioInputs: readonly EnumeratedDevice[];
  readonly audioOutputs: readonly EnumeratedDevice[];
  readonly videoInputs: readonly EnumeratedDevice[];
}

const EMPTY_LISTS: MediaDeviceLists = {
  audioInputs: [SYSTEM_DEFAULT_DEVICE],
  audioOutputs: [SYSTEM_DEFAULT_DEVICE],
  videoInputs: [SYSTEM_DEFAULT_DEVICE],
};

/**
 * Live, hot-plug-aware device lists for the Settings panel. Re-enumerates on mount and on every
 * `navigator.mediaDevices.ondevicechange` event, with the listener removed on unmount — a leaked
 * `devicechange` listener across remounts is exactly the class of bug this codebase has hit before
 * (see T4's unmemoized-actions-object regression), so cleanup here is deliberate and unconditional.
 */
export function useMediaDevices(): MediaDeviceLists {
  const [lists, setLists] = useState<MediaDeviceLists>(EMPTY_LISTS);

  useEffect(() => {
    let cancelled = false;

    function refresh(): void {
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (cancelled) return;
          setLists({
            audioInputs: withSystemDefault(toEnumeratedDevices(devices, 'audioinput')),
            audioOutputs: withSystemDefault(toEnumeratedDevices(devices, 'audiooutput')),
            videoInputs: withSystemDefault(toEnumeratedDevices(devices, 'videoinput')),
          });
        })
        .catch((error: unknown) => {
          console.error('device enumeration failed', error);
        });
    }

    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
    };
  }, []);

  return lists;
}
