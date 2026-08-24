import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { VideoOff } from 'lucide-react';

import type { ScreenQualityPreset } from '@disco-voador/media-core';

import type { DesktopIdentity, DesktopSetPttShortcutResult } from '../../shared/ipc-contract.js';
import { useBookmarks } from '../connection/use-bookmarks.js';
import { IdentityPanel } from '../identity/IdentityPanel.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import type { VoiceChannelActions, VoiceChannelState } from './use-voice-channel.js';
import { useMediaDevices, type EnumeratedDevice } from './device-enumeration.js';
import { LocalCameraPreview } from './LocalCameraPreview.js';
import {
  describePttBinding,
  pttBindingFromKeyboardEvent,
  pttBindingFromMouseEvent,
} from './ptt-capture.js';
import styles from './SettingsPanel.module.css';

/** T13.1.1 — the four truthful sections `SettingsPanel` actually has real content for. Deliberately
 * no "Appearance" section — no such functionality exists in this app; adding one here would be the
 * exact kind of fabricated-capability UI `docs/DEFINITION_OF_DONE.md` forbids. */
type SettingsSection = 'profile' | 'voice' | 'screen' | 'advanced';

const SETTINGS_SECTIONS: readonly { readonly id: SettingsSection; readonly label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'voice', label: 'Voice & Video' },
  { id: 'screen', label: 'Screen Share' },
  { id: 'advanced', label: 'Advanced' },
];

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
  /** T13.1 — the User & Identity section renders the existing `IdentityPanel` (T7) in place, rather
   * than duplicating its nickname/identityId/regenerate logic here. */
  readonly identity: DesktopIdentity;
  readonly nickname: string;
  readonly onNicknameChange: (nickname: string) => Promise<boolean>;
  readonly onRegenerateIdentity: () => Promise<void>;
  /** T13.1 — the per-join display-name convenience field (T7 Section 41's own doc comment: never
   * merged with the identity `nickname` above). Relocated here from the retired pre-join screen. */
  readonly voiceDisplayName: string;
  readonly onVoiceDisplayNameChange: (value: string) => void;
}

// Stale since T4/T5/T10/T12 shipped camera, screen sharing, text chat, and Windows per-process
// audio respectively — corrected here (found while touching this file for T11, relocated into
// Settings > Advanced for T13.1) rather than continuing to show a real user false information
// about what OvniChat can already do.
const NOT_IMPLEMENTED = [
  'Servers (multiple guild-style groupings)',
  'Message editing and deletion',
] as const;

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
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <select
        className={styles.select}
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

      // T13.4 — guarded (previously unguarded): once this hook could activate automatically just by
      // viewing the Voice & Video section in Voice Activity mode (not only via an explicit "Test
      // microphone" click), an environment without a real `AudioContext`/`getUserMedia` (e.g. this
      // component's own test suite, most of which never installs the Web Audio test doubles since
      // most tests have nothing to do with audio) must degrade to "no meter", never an unhandled
      // rejection.
      let audioContextCandidate: AudioContext;
      try {
        const AudioContextCtor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioContextCandidate = new AudioContextCtor();
      } catch (error) {
        console.error('mic level meter: AudioContext unavailable', error);
        if (temporaryStream) for (const track of temporaryStream.getTracks()) track.stop();
        return;
      }
      audioContext = audioContextCandidate;
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

/** T13.4 — one real, honest outcome the "Shortcut: [Press a key...]" capture control can be in.
 * Never a bare boolean: "already registered" / "conflict" / "native failure" all need distinct copy
 * per this task's own product requirement ("never require DevTools to know if it worked"). */
type PttShortcutStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'capturing' }
  | { readonly kind: 'registering' }
  | { readonly kind: 'registered' }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * T13.4 QA fix — short, honest, jargon-free copy for the two PTT failure reasons whose underlying
 * `result.message` is an arbitrary native-diagnostic string (`describeError(err)` in
 * `packages/windows-media/src/ptt-hotkey-listener.ts` — e.g. `node-gyp-build`'s own
 * "No native build was found for platform=... loaded from: ..." text), never something written for
 * an end user to read. `'conflict'` is deliberately not mapped here — `main/ptt-hotkey.ts`'s own
 * `setPttShortcut` already produces a short, curated, user-facing message for that reason
 * (`'That shortcut is already in use — choose another key.'`), so `applyResult` below keeps showing
 * `result.message` unchanged only for that one case.
 */
const PTT_FAILURE_COPY: Record<'native-module-load-failed' | 'hook-start-failed', string> = {
  'native-module-load-failed':
    'Shortcut unavailable — something went wrong starting the global hotkey listener. Try restarting OvniChat, or contact support if this keeps happening.',
  'hook-start-failed':
    'Shortcut unavailable — something went wrong starting the global hotkey listener. Try restarting OvniChat, or contact support if this keeps happening.',
};

/**
 * T13.4 — Renderer-local, focused-window key/mouse-button capture (see `ptt-capture.ts`'s own doc
 * comment for why this is deliberately *not* the global hook) for picking a PTT binding, then
 * calling the real `actions.setPttShortcut` and surfacing its real, honest result — conflict, a
 * native-module/hook-start failure, or success — never a fabricated "it worked". `Escape` cancels
 * capture without binding anything (this module's own key-code table can otherwise map `Escape`
 * itself as a bindable key, which would be a confusing capture-vs-cancel conflict for the one key
 * every other dialog already uses to close).
 */
function usePttShortcutCapture(actions: VoiceChannelActions): {
  readonly status: PttShortcutStatus;
  readonly startCapture: () => void;
} {
  const [status, setStatus] = useState<PttShortcutStatus>({ kind: 'idle' });

  useEffect(() => {
    if (status.kind !== 'capturing') return undefined;

    let settled = false;

    function applyResult(result: DesktopSetPttShortcutResult): void {
      if (result.ok) {
        setStatus({ kind: 'registered' });
        return;
      }
      if (result.reason === 'conflict') {
        setStatus({ kind: 'conflict', message: result.message });
        return;
      }
      // T13.4 QA fix — `result.message` here is a raw, arbitrary native-diagnostic string (see
      // `PTT_FAILURE_COPY`'s own doc comment); it is logged (local-diagnostic-only, matching
      // `ptt-hotkey-listener.ts`'s own "never surfaced to the user" posture for this exact string)
      // rather than rendered, so the underlying detail is never lost, just never shown raw.
      console.error(`ptt-shortcut: ${result.reason}`, result.message);
      setStatus({ kind: 'error', message: PTT_FAILURE_COPY[result.reason] });
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (settled) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        settled = true;
        setStatus({ kind: 'idle' });
        return;
      }
      const binding = pttBindingFromKeyboardEvent(event);
      if (!binding) return; // Unsupported key — keep listening rather than silently mis-binding.
      event.preventDefault();
      event.stopPropagation();
      settled = true;
      setStatus({ kind: 'registering' });
      void actions.setPttShortcut(binding).then(applyResult);
    }

    function handleMouseDown(event: MouseEvent): void {
      if (settled) return;
      const binding = pttBindingFromMouseEvent(event);
      if (!binding) return;
      event.preventDefault();
      event.stopPropagation();
      settled = true;
      setStatus({ kind: 'registering' });
      void actions.setPttShortcut(binding).then(applyResult);
    }

    // `capture: true` so this observes the key/button before any other handler (including
    // `Modal.tsx`'s own Escape-closes-dialog listener) — this control owns the very next input
    // event while capturing, exactly matching "press a key to bind" UX in comparable apps.
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('mousedown', handleMouseDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('mousedown', handleMouseDown, true);
    };
  }, [status.kind, actions]);

  return {
    status,
    startCapture: () => {
      setStatus({ kind: 'capturing' });
    },
  };
}

/**
 * T11 device management + screen-share quality preference, restyled for T13.1 (single scrolling
 * column) then redesigned for T13.1.1 into a sidebar-navigation layout across four truthful
 * sections (Profile / Voice & Video / Screen Share / Advanced), rendered inside `ui/Modal.tsx`
 * (`size="xlarge"`) by `VoiceChannelView.tsx` — a sibling of `AuthorizationPanel.tsx` rather than
 * folded into the already-large `VoiceChannelView.tsx`.
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
  identity,
  nickname,
  onNicknameChange,
  onRegenerateIdentity,
  voiceDisplayName,
  onVoiceDisplayNameChange,
}: SettingsPanelProps): ReactElement {
  const [activeSection, setActiveSection] = useState<SettingsSection>('profile');
  const devices = useMediaDevices();
  const [preferredMicDeviceId, setPreferredMicDeviceId] = useState<string | null>(null);
  const [preferredCameraDeviceId, setPreferredCameraDeviceId] = useState<string | null>(null);
  const [micTesting, setMicTesting] = useState(false);
  const [{ connectOnStartup }, bookmarkActions] = useBookmarks();
  // T13.1 — relocated from the old always-visible `App.tsx` "T1 Electron Shell" block into
  // Settings > Advanced: real Electron/app version diagnostics, never deleted, just no longer
  // prominent in the main product flow (T13.1 rule #6).
  const [versionInfo, setVersionInfo] = useState<
    { readonly electronVersion: string; readonly appVersion: string } | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    window.desktopApp
      .getVersionInfo()
      .then((info) => {
        if (!cancelled) setVersionInfo(info);
      })
      .catch((error: unknown) => {
        console.error('settings panel: failed to load version info', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  // T13.4 — Voice Activity mode's own live level meter reuses this exact same lifecycle-safe hook
  // (never a second/parallel capture mechanism — see `useMicLevelMeter`'s own T13.1.1 fix), gated on
  // being both in this settings section *and* Voice Activity mode, so it stops the instant either
  // stops being true (leaving this section, or switching to Push to Talk) — never lingers.
  const voiceActivityMeterActive =
    activeSection === 'voice' && state.voiceInputMode === 'voice-activity';
  const voiceActivityLevel = useMicLevelMeter(
    voiceActivityMeterActive,
    state.localMicrophoneStream,
    preferredMicDeviceId,
  );
  const pttShortcutCapture = usePttShortcutCapture(actions);

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
    // T13.4 — tells the shared remote-audio graph (per-participant volume/speaking playback) and
    // join/leave-sound playback which device to route to, mirroring `handleMicChange`'s own
    // "live behavior via an action, persistence via `updateClientSettings`" split exactly.
    actions.setOutputDevice(deviceId);
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

  const cameraPreviewActive = state.cameraEnabled && state.localCameraStream;

  return (
    <div data-role="settings-panel" className={styles.container}>
      {/* T13.1.1 — sidebar-navigation information architecture: only sections with real, truthful
          content (no fabricated "Appearance" section). Identity/cryptography content stays under
          Advanced, unchanged from T13.1's own fix. */}
      <nav className={styles.nav} aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`${styles.navItem} ${
              activeSection === section.id ? styles.navItemActive : ''
            }`}
            aria-current={activeSection === section.id ? 'true' : undefined}
            onClick={() => {
              // Security review (T13.1.1): the microphone test's stop control and level meter only
              // render inside the "Voice & Video" section — without this, navigating away while a
              // test is running left a real `getUserMedia` capture active with no visible indicator
              // and no reachable way to stop it short of closing Settings entirely.
              if (section.id !== 'voice') setMicTesting(false);
              setActiveSection(section.id);
            }}
            data-testid={`settings-nav-${section.id}`}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <div className={styles.content}>
        {activeSection === 'profile' && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Profile</h3>
            {/* T13.1.1 QA fix: the hint is a sibling of the <label> (this outer wrapper reuses
                `.field`'s own flex/gap so the visual stacking is unchanged), not nested inside it —
                matching every other hint in this file (e.g. the microphone/camera fallback notices
                below). Nesting it inside the <label> would make the input's implicit accessible
                name the full hint sentence concatenated after "Voice display name" instead of just
                the field name itself, every time a screen reader announces this control. */}
            <div className={styles.field}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Voice display name</span>
                <input
                  className={styles.input}
                  value={voiceDisplayName}
                  onChange={(event) => {
                    onVoiceDisplayNameChange(event.target.value);
                  }}
                  maxLength={32}
                />
              </label>
              <span className={styles.hint}>
                Shown to others when you join a voice channel — independent of your identity
                nickname, found under Advanced.
              </span>
            </div>
          </section>
        )}

        {activeSection === 'voice' && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Voice &amp; Video</h3>

            <section className={styles.subsection}>
              <h4 className={styles.subsectionTitle}>Audio</h4>
              <DeviceSelect
                label="Microphone"
                devices={devices.audioInputs}
                selectedDeviceId={preferredMicDeviceId}
                onChange={handleMicChange}
              />
              {state.micUsingFallback && (
                <p className={styles.status} role="status">
                  Preferred microphone unavailable — using the system default.
                </p>
              )}
              {state.micDisconnected && (
                <p className={styles.alert} role="alert">
                  Microphone disconnected unexpectedly. Pick a device to resume.
                </p>
              )}

              <div className={styles.testRow}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setMicTesting((prev) => !prev);
                  }}
                >
                  {micTesting ? 'Stop microphone test' : 'Test microphone'}
                </Button>
                {micTesting && (
                  <div className={styles.meterTrack} data-role="mic-level-meter">
                    <div
                      className={styles.meterFill}
                      style={{ width: `${String(Math.min(100, Math.round(micLevel * 100)))}%` }}
                    />
                  </div>
                )}
              </div>

              <DeviceSelect
                label="Speaker"
                devices={devices.audioOutputs}
                selectedDeviceId={outputDeviceId}
                disabled={!outputDeviceSelectionSupported}
                onChange={handleOutputChange}
              />
              {!outputDeviceSelectionSupported && (
                <p className={styles.hint}>Speaker selection is not supported on this build.</p>
              )}
              <div className={styles.testRow}>
                <Button
                  variant="secondary"
                  disabled={!outputDeviceSelectionSupported}
                  onClick={() => {
                    if (outputTestTone.playing) outputTestTone.stop();
                    else outputTestTone.play(outputDeviceId);
                  }}
                >
                  {outputTestTone.playing ? 'Stop test tone' : 'Play test tone'}
                </Button>
              </div>
            </section>

            <section className={styles.subsection}>
              <h4 className={styles.subsectionTitle}>Input Mode</h4>
              <div className={styles.radioGroup} role="radiogroup" aria-label="Input mode">
                <label className={styles.radioOption}>
                  <input
                    type="radio"
                    name="voice-input-mode"
                    checked={state.voiceInputMode === 'voice-activity'}
                    onChange={() => {
                      actions.setVoiceInputMode('voice-activity');
                    }}
                    data-testid="voice-input-mode-voice-activity"
                  />
                  Voice Activity
                </label>
                <label className={styles.radioOption}>
                  <input
                    type="radio"
                    name="voice-input-mode"
                    checked={state.voiceInputMode === 'push-to-talk'}
                    onChange={() => {
                      actions.setVoiceInputMode('push-to-talk');
                    }}
                    data-testid="voice-input-mode-push-to-talk"
                  />
                  Push to Talk
                </label>
              </div>

              {state.voiceInputMode === 'voice-activity' ? (
                <div className={styles.inputModeDetail}>
                  <label className={styles.sliderLabel} htmlFor="voice-activity-sensitivity">
                    Input Sensitivity
                  </label>
                  <input
                    id="voice-activity-sensitivity"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={state.voiceActivitySensitivity}
                    onChange={(event) => {
                      actions.setVoiceActivitySensitivity(Number(event.target.value));
                    }}
                    data-testid="voice-activity-sensitivity-slider"
                  />
                  {/* Visual-only mic level meter — never an audible test tone (that is the unrelated
                      "Play test tone" *output*-device test above); stops the instant this section is
                      left or the mode switches away, via `useMicLevelMeter`'s existing lifecycle
                      fix. */}
                  <div
                    className={styles.meterTrack}
                    data-role="voice-activity-level-meter"
                    data-testid="voice-activity-level-meter"
                  >
                    <div
                      className={styles.meterFill}
                      style={{
                        width: `${String(Math.min(100, Math.round(voiceActivityLevel * 100)))}%`,
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className={styles.inputModeDetail}>
                  <p className={styles.hint}>Shortcut</p>
                  <Button
                    variant="secondary"
                    onClick={pttShortcutCapture.startCapture}
                    disabled={pttShortcutCapture.status.kind === 'capturing'}
                    data-testid="ptt-shortcut-capture-button"
                  >
                    {pttShortcutCapture.status.kind === 'capturing'
                      ? 'Press a key… (Esc to cancel)'
                      : state.pttBinding
                        ? describePttBinding(state.pttBinding)
                        : 'Press a key…'}
                  </Button>
                  {state.pttBinding && pttShortcutCapture.status.kind === 'idle' && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        void actions.clearPttShortcut();
                      }}
                      data-testid="ptt-shortcut-clear-button"
                    >
                      Clear shortcut
                    </Button>
                  )}
                  <p
                    className={
                      pttShortcutCapture.status.kind === 'conflict' ||
                      pttShortcutCapture.status.kind === 'error'
                        ? styles.alert
                        : styles.status
                    }
                    role={
                      pttShortcutCapture.status.kind === 'conflict' ||
                      pttShortcutCapture.status.kind === 'error'
                        ? 'alert'
                        : 'status'
                    }
                    data-testid="ptt-shortcut-status"
                  >
                    {pttShortcutCapture.status.kind === 'registering' && 'Registering…'}
                    {pttShortcutCapture.status.kind === 'registered' && 'Shortcut registered'}
                    {pttShortcutCapture.status.kind === 'conflict' &&
                      'That shortcut is already in use — choose another key.'}
                    {pttShortcutCapture.status.kind === 'error' &&
                      pttShortcutCapture.status.message}
                    {pttShortcutCapture.status.kind === 'idle' &&
                      state.pttBinding &&
                      'Shortcut registered'}
                    {pttShortcutCapture.status.kind === 'idle' &&
                      !state.pttBinding &&
                      'No shortcut set yet — Push to Talk will never transmit until you pick one.'}
                  </p>
                  <p className={styles.hint}>
                    {state.pttHeld ? 'Currently held (transmitting).' : ''}
                  </p>
                </div>
              )}

              <label className={styles.checkboxOption}>
                <input
                  type="checkbox"
                  checked={state.joinLeaveSoundsEnabled}
                  onChange={(event) => {
                    actions.setJoinLeaveSoundsEnabled(event.target.checked);
                  }}
                  data-testid="join-leave-sounds-toggle"
                />
                Voice Notifications: Play join/leave sounds
              </label>
            </section>

            <section className={styles.subsection}>
              <h4 className={styles.subsectionTitle}>Video</h4>
              <DeviceSelect
                label="Camera"
                devices={devices.videoInputs}
                selectedDeviceId={preferredCameraDeviceId}
                onChange={handleCameraChange}
              />
              {state.cameraUsingFallback && (
                <p className={styles.status} role="status">
                  Preferred camera unavailable — using the system default.
                </p>
              )}
              <div className={styles.cameraPreviewBox}>
                {cameraPreviewActive && state.localCameraStream ? (
                  <LocalCameraPreview stream={state.localCameraStream} />
                ) : (
                  <EmptyState
                    icon={VideoOff}
                    title="Camera is off"
                    description="Enable the camera to preview it here."
                  />
                )}
              </div>
            </section>
          </section>
        )}

        {activeSection === 'screen' && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Screen Share</h3>
            {/* T13.1.1 QA fix: sibling of the <label>, not nested inside it — see the matching fix
                and doc comment on the "Voice display name" field above for why. */}
            <div className={styles.field}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Default quality</span>
                <select
                  className={styles.select}
                  value={screenQualityPreset}
                  onChange={handleQualityChange}
                >
                  {QUALITY_OPTIONS.map((preset) => (
                    <option key={preset} value={preset}>
                      {QUALITY_LABELS[preset]}
                    </option>
                  ))}
                </select>
              </label>
              <span className={styles.hint}>
                Pre-selects this quality the next time you open the screen-share picker — you can
                still change it per-share.
              </span>
            </div>
          </section>
        )}

        {activeSection === 'advanced' && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Advanced</h3>

            <section className={styles.subsection}>
              <h4 className={styles.subsectionTitle}>Startup</h4>
              <label className={styles.checkboxField}>
                <input
                  type="checkbox"
                  checked={connectOnStartup}
                  onChange={(event) => {
                    bookmarkActions.setConnectOnStartup(event.target.checked);
                  }}
                />
                Connect automatically on startup
              </label>
              <p className={styles.hint}>
                Reconnects to the last server you connected to, using the same identity as always —
                never a new account or credential.
              </p>
            </section>

            {/* T13.1 (visual QA follow-up, reaffirmed T13.1.1): the cryptographic Identity ID and
                the destructive "Regenerate Identity" action stay out of the main settings flow —
                `IdentityPanel` itself now visually separates its own routine controls from the
                Regenerate danger zone (see `identity/IdentityPanel.tsx`). */}
            <section className={styles.subsection}>
              <h4 className={styles.subsectionTitle}>Identity</h4>
              <IdentityPanel
                nickname={nickname}
                identity={identity}
                onNicknameChange={onNicknameChange}
                onRegenerate={onRegenerateIdentity}
              />
            </section>

            <section className={styles.subsection}>
              <h4 className={styles.subsectionTitle}>Diagnostics</h4>
              <dl className={styles.diagnostics}>
                <dt>Electron</dt>
                <dd>{versionInfo?.electronVersion ?? '…'}</dd>
                <dt>App version</dt>
                <dd>{versionInfo?.appVersion ?? '…'}</dd>
              </dl>
            </section>

            <section className={styles.subsection}>
              <h4 className={styles.subsectionTitle}>Not implemented yet</h4>
              <ul className={styles.notImplemented}>
                {NOT_IMPLEMENTED.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          </section>
        )}
      </div>
    </div>
  );
}
