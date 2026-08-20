import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';

import type { ScreenQualityPreset } from '@disco-voador/media-core';

import type { VoiceChannelActions, VoiceChannelState } from './use-voice-channel.js';
import { useMediaDevices, type EnumeratedDevice } from './device-enumeration.js';
import { LocalCameraPreview } from './LocalCameraPreview.js';

interface SettingsPanelProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  /** `null` = system default, `undefined` = not loaded yet (treated identically to `null` by
   * `RemoteAudio.tsx`). Lifted up to `VoiceChannelView.tsx` because it feeds every `RemoteAudio`
   * instance this panel does not itself render (both microphone and screen-audio remote streams —
   * T11 Section 80). */
  readonly outputDeviceId: string | null;
  readonly onOutputDeviceChange: (deviceId: string | null) => void;
  /** The default quality `ScreenSourcePicker.tsx` pre-selects for the *next* share — this panel
   * only changes the default, it never starts a capture itself (T11 Section 34, mandatory). */
  readonly screenQualityPreset: ScreenQualityPreset;
  readonly onScreenQualityPresetChange: (preset: ScreenQualityPreset) => void;
  /** `true` once `HTMLMediaElement.setSinkId` was confirmed present on this build at mount time —
   * see this file's own doc comment for the version this was checked against. When `false`, the
   * speaker dropdown and output test tone are rendered disabled with an explanatory note instead of
   * silently pretending to work (T11 Section 18: never fake a working selector). */
  readonly outputDeviceSelectionSupported: boolean;
}

const QUALITY_OPTIONS: readonly ScreenQualityPreset[] = ['standard', 'high', 'smooth', 'smooth720'];
const QUALITY_LABELS: Record<ScreenQualityPreset, string> = {
  standard: 'Standard 720p30',
  high: 'High 1080p30 (recommended)',
  smooth: 'Smooth 1080p60',
  smooth720: 'Smooth 720p60',
};

function deviceOptionValue(deviceId: string | null): string {
  return deviceId ?? '';
}

function parseDeviceOptionValue(value: string): string | null {
  return value === '' ? null : value;
}

function DeviceSelect({
  label,
  devices,
  selectedDeviceId,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly devices: readonly EnumeratedDevice[];
  readonly selectedDeviceId: string | null;
  readonly disabled?: boolean;
  readonly onChange: (deviceId: string | null) => void;
}): ReactElement {
  function handleChange(event: ChangeEvent<HTMLSelectElement>): void {
    onChange(parseDeviceOptionValue(event.target.value));
  }

  return (
    <label>
      {label}
      <select
        value={deviceOptionValue(selectedDeviceId)}
        onChange={handleChange}
        disabled={disabled}
      >
        {devices.map((device) => (
          <option
            key={deviceOptionValue(device.deviceId)}
            value={deviceOptionValue(device.deviceId)}
          >
            {device.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Local-only microphone level meter (T11 Section 32, mandatory: no server involvement, no
 * recording — a plain Web Audio `AnalyserNode` tap that never leaves this process). Reuses
 * `activeStream` (the live call's own microphone, `state.localMicrophoneStream`) when present, so
 * testing never opens a second concurrent capture on top of an active call; only acquires its own
 * temporary stream (released the moment the meter stops) when no call is using the microphone yet.
 */
function useMicLevelMeter(
  testing: boolean,
  activeStream: MediaStream | undefined,
  preferredDeviceId: string | null,
): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!testing) {
      setLevel(0);
      return undefined;
    }

    let cancelled = false;
    let audioContext: AudioContext | undefined;
    let animationFrame: number | undefined;
    let temporaryStream: MediaStream | undefined;

    void (async () => {
      let sourceStream = activeStream;
      if (!sourceStream) {
        try {
          sourceStream = await navigator.mediaDevices.getUserMedia({
            audio: preferredDeviceId === null ? true : { deviceId: preferredDeviceId },
            video: false,
          });
        } catch (error) {
          console.error('mic level meter: failed to acquire a temporary microphone', error);
          return;
        }
        if (cancelled) {
          for (const track of sourceStream.getTracks()) track.stop();
          return;
        }
        temporaryStream = sourceStream;
      }

      const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(sourceStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);

      const tick = (): void => {
        analyser.getByteTimeDomainData(buffer);
        let sumSquares = 0;
        for (const value of buffer) {
          const normalized = (value - 128) / 128;
          sumSquares += normalized * normalized;
        }
        setLevel(Math.sqrt(sumSquares / buffer.length));
        animationFrame = requestAnimationFrame(tick);
      };
      tick();
    })();

    return () => {
      cancelled = true;
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      if (audioContext) void audioContext.close();
      if (temporaryStream) {
        for (const track of temporaryStream.getTracks()) track.stop();
      }
    };
  }, [testing, activeStream, preferredDeviceId]);

  return level;
}

/** Plays a short, locally-generated 440Hz tone through the selected output device, mirroring the
 * exact `OscillatorNode` technique `apps/desktop/scripts/e2e-screen-audio-smoke.mjs` already uses
 * for its own deterministic test tone. Routed through a hidden `<audio>` element fed by a
 * `MediaStreamAudioDestinationNode` (rather than `AudioContext.destination` directly) specifically
 * because `setSinkId` is only defined on `HTMLMediaElement`, not on `AudioContext` — this is the
 * same mechanism `RemoteAudio.tsx` uses for actual remote audio, applied to a locally-generated
 * source instead. A safe, moderate volume (`gain = 0.2`) and a short, bounded duration (2.5s, or
 * "Stop" pressed early) — never full volume, never indefinite.
 */
function useOutputTestTone(): {
  readonly playing: boolean;
  play: (outputDeviceId: string | null) => void;
  stop: () => void;
} {
  const [playing, setPlaying] = useState(false);
  const stopRef = useRef<(() => void) | undefined>(undefined);

  function stop(): void {
    stopRef.current?.();
    stopRef.current = undefined;
    setPlaying(false);
  }

  function play(outputDeviceId: string | null): void {
    if (stopRef.current) return;

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioContext = new AudioContextCtor();
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    const gain = audioContext.createGain();
    gain.gain.value = 0.2;
    const destinationNode = audioContext.createMediaStreamDestination();
    oscillator.connect(gain);
    gain.connect(destinationNode);
    oscillator.start();

    const audioElement = document.createElement('audio');
    audioElement.srcObject = destinationNode.stream;
    audioElement.autoplay = true;
    if (typeof audioElement.setSinkId === 'function') {
      audioElement.setSinkId(outputDeviceId ?? '').catch((error: unknown) => {
        console.error('output test tone: failed to set output device', error);
      });
    }
    void audioElement.play().catch((error: unknown) => {
      console.error('output test tone: failed to play', error);
    });

    const durationTimer = setTimeout(() => {
      stop();
    }, 2_500);

    stopRef.current = () => {
      clearTimeout(durationTimer);
      oscillator.stop();
      void audioContext.close();
      audioElement.srcObject = null;
    };
    setPlaying(true);
  }

  useEffect(
    () => () => {
      stopRef.current?.();
    },
    [],
  );

  return { playing, play, stop };
}

/**
 * T11 device management + screen-share quality preference. A minimal, functional (not polished)
 * panel per this task's own guidance — plain forms, no styling framework, sibling of
 * `AuthorizationPanel.tsx`/`ChatPanel.tsx` rather than folded into the already-large
 * `VoiceChannelView.tsx`.
 *
 * **`setSinkId` support finding**: confirmed present in this app's pinned Electron 43.4.0 build
 * (Chromium ~150 per Electron's own release notes) — `HTMLMediaElement.prototype.setSinkId` is
 * defined and callable, and the current `typescript` package's bundled `lib.dom.d.ts` already types
 * it unprefixed, unconditionally. Per the Audio Output Devices specification and MDN, a non-default
 * output device requires prior permission, granted either via `MediaDevices.selectAudioOutput()` or
 * by having already been revealed through a `getUserMedia()` call from the same origin — this app
 * already calls `getUserMedia()` for the microphone before any output-device dropdown would be
 * populated with real labels/ids, so `enumerateDevices()`'s `audiooutput` entries are expected to
 * be usable directly with `setSinkId` without a separate `selectAudioOutput()` picker step, the same
 * pattern long used by other Electron-based voice apps. This has not been independently verified by
 * physically swapping a second real output device on this machine during this task (only one output
 * device was available to test with) — see the final report for this caveat stated plainly, per
 * T11 Section 18's "never fake a working selector, but do say what was and was not tested" spirit.
 */
export function SettingsPanel({
  state,
  actions,
  outputDeviceId,
  onOutputDeviceChange,
  screenQualityPreset,
  onScreenQualityPresetChange,
  outputDeviceSelectionSupported,
}: SettingsPanelProps): ReactElement {
  const devices = useMediaDevices();
  const [preferredMicDeviceId, setPreferredMicDeviceId] = useState<string | null>(null);
  const [preferredCameraDeviceId, setPreferredCameraDeviceId] = useState<string | null>(null);
  const [micTesting, setMicTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.desktopApp
      .getClientSettings()
      .then((settings) => {
        if (cancelled) return;
        setPreferredMicDeviceId(settings.audio.inputDeviceId);
        setPreferredCameraDeviceId(settings.video.cameraDeviceId);
      })
      .catch((error: unknown) => {
        console.error('settings panel: failed to load persisted settings', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const micLevel = useMicLevelMeter(micTesting, state.localMicrophoneStream, preferredMicDeviceId);
  const outputTestTone = useOutputTestTone();

  function handleMicChange(deviceId: string | null): void {
    setPreferredMicDeviceId(deviceId);
    actions.switchMicrophone(deviceId);
    window.desktopApp
      .updateClientSettings({ audio: { inputDeviceId: deviceId } })
      .catch((error: unknown) => {
        console.error('settings panel: failed to persist microphone preference', error);
      });
  }

  function handleCameraChange(deviceId: string | null): void {
    setPreferredCameraDeviceId(deviceId);
    actions.switchCamera(deviceId);
    window.desktopApp
      .updateClientSettings({ video: { cameraDeviceId: deviceId } })
      .catch((error: unknown) => {
        console.error('settings panel: failed to persist camera preference', error);
      });
  }

  function handleOutputChange(deviceId: string | null): void {
    onOutputDeviceChange(deviceId);
    window.desktopApp
      .updateClientSettings({ audio: { outputDeviceId: deviceId } })
      .catch((error: unknown) => {
        console.error('settings panel: failed to persist output device preference', error);
      });
  }

  function handleQualityChange(event: ChangeEvent<HTMLSelectElement>): void {
    const preset = event.target.value as ScreenQualityPreset;
    onScreenQualityPresetChange(preset);
    window.desktopApp
      .updateClientSettings({ screenShare: { qualityPreset: preset } })
      .catch((error: unknown) => {
        console.error('settings panel: failed to persist screen-share quality preference', error);
      });
  }

  return (
    <section data-role="settings-panel">
      <h3>Settings</h3>

      <section>
        <h4>Audio</h4>
        <DeviceSelect
          label="Microphone"
          devices={devices.audioInputs}
          selectedDeviceId={preferredMicDeviceId}
          onChange={handleMicChange}
        />
        {state.micUsingFallback && (
          <p role="status">Preferred microphone unavailable — using the system default.</p>
        )}
        {state.micDisconnected && (
          <p role="alert">Microphone disconnected unexpectedly. Pick a device to resume.</p>
        )}
        <DeviceSelect
          label="Speaker"
          devices={devices.audioOutputs}
          selectedDeviceId={outputDeviceId}
          disabled={!outputDeviceSelectionSupported}
          onChange={handleOutputChange}
        />
        {!outputDeviceSelectionSupported && (
          <p>Speaker selection is not supported on this build.</p>
        )}
        <div>
          <button
            type="button"
            onClick={() => {
              setMicTesting((prev) => !prev);
            }}
          >
            {micTesting ? 'Stop microphone test' : 'Test microphone'}
          </button>
          {micTesting && <meter data-role="mic-level-meter" min={0} max={1} value={micLevel} />}
        </div>
        <div>
          <button
            type="button"
            disabled={!outputDeviceSelectionSupported}
            onClick={() => {
              if (outputTestTone.playing) outputTestTone.stop();
              else outputTestTone.play(outputDeviceId);
            }}
          >
            {outputTestTone.playing ? 'Stop test tone' : 'Play test tone'}
          </button>
        </div>
      </section>

      <section>
        <h4>Video</h4>
        <DeviceSelect
          label="Camera"
          devices={devices.videoInputs}
          selectedDeviceId={preferredCameraDeviceId}
          onChange={handleCameraChange}
        />
        {state.cameraUsingFallback && (
          <p role="status">Preferred camera unavailable — using the system default.</p>
        )}
        {state.cameraEnabled && state.localCameraStream ? (
          <LocalCameraPreview stream={state.localCameraStream} />
        ) : (
          <p>Enable the camera to preview it here.</p>
        )}
      </section>

      <section>
        <h4>Screen sharing</h4>
        <label>
          Default quality
          <select value={screenQualityPreset} onChange={handleQualityChange}>
            {QUALITY_OPTIONS.map((preset) => (
              <option key={preset} value={preset}>
                {QUALITY_LABELS[preset]}
              </option>
            ))}
          </select>
        </label>
      </section>
    </section>
  );
}
