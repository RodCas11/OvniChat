import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';

import { SCREEN_QUALITY_PRESETS, type ScreenQualityPreset } from '@disco-voador/media-core';

import type {
  DesktopProcessAudioCandidate,
  DesktopScreenSource,
} from '../../shared/ipc-contract.js';
import { Button } from '../ui/Button.js';
import styles from './ScreenSourcePicker.module.css';

/**
 * T12 — the user's screen-share audio choice: no audio, Windows system-wide loopback (T6), or one
 * running application's own audio via Windows process-loopback capture (T12). Mutually exclusive —
 * never more than one of these is active for a given share. Exported so `VoiceChannelView.tsx`/
 * `use-voice-channel.ts` can type `enableScreenShare`'s second parameter without redefining this
 * shape, and so `main/process-audio.ts`'s Renderer-facing counterpart types line up by construction.
 */
export type ScreenShareAudioMode =
  | { readonly type: 'none' }
  | { readonly type: 'system' }
  | { readonly type: 'process'; readonly pid: number };

/**
 * Self-contained screen/window source picker: enumerate → pick one → choose a quality preset →
 * choose an audio mode (None / System audio / Application audio) → Share. Never auto-selects
 * anything and never calls `selectScreenShareSource` speculatively — the IPC selection call only
 * happens inside `handleShare`, so Cancel (which never calls it) can never have any side effect on
 * an already-active voice/camera session by construction, not by an extra guard.
 *
 * Prop contract for the caller (`VoiceChannelView.tsx`): `onSourceSelected` fires only after
 * `desktopApp.selectScreenShareSource` resolved `true` for the user's chosen source, with the user's
 * chosen `ScreenQualityPreset` and {@link ScreenShareAudioMode} — the caller is expected to then
 * acquire/publish accordingly (`acquireScreen` for video and, for `'system'`, its own audio track;
 * `acquireProcessAudioTrack` from `apps/desktop/src/renderer/media/process-audio-bridge.ts` for
 * `'process'`); this component does not do that itself. `onCancel` fires when the user dismisses the
 * picker without sharing; it carries no arguments and this component performs no IPC call before
 * invoking it.
 *
 * Audio mode defaults to `'none'` (T6/T12 requirement: never silently share any audio) and is always
 * an explicit user choice. For `'system'`, it is armed alongside the video source in the same
 * `selectScreenShareSource` call (see `main/screen-share.ts`); for `'process'`, video is armed via
 * `selectScreenShareSource(id, false)` (process-audio never rides Windows system-loopback) and the
 * actual capture starts separately, driven by the caller after `onSourceSelected` fires (mirrors how
 * this component never itself calls `acquireScreen` either).
 *
 * "Application audio" is gated on `desktopApp.getProcessAudioCapability()` — hidden behind an honest,
 * visible explanation (never silently omitted, never silently substituting system audio) when
 * unsupported. See `docs/tasks/T12_WINDOWS_PROCESS_AUDIO.md`.
 */
export interface ScreenSourcePickerProps {
  readonly onSourceSelected: (
    quality: ScreenQualityPreset,
    audioMode: ScreenShareAudioMode,
  ) => void;
  readonly onCancel: () => void;
  /** T11 — pre-selects the quality dropdown from the persisted `screenShare.qualityPreset`
   * preference (`SettingsPanel.tsx`). Only changes this picker's default selection, exactly like
   * today's hardcoded `DEFAULT_QUALITY` did — still never starts a capture by itself, and the user
   * can still freely change it before sharing. Defaults to `'high'` (this module's own prior
   * default) when the caller has not loaded a preference yet. */
  readonly defaultQuality?: ScreenQualityPreset | undefined;
}

function describeProcessAudioUnsupportedReason(reason: 'not-windows' | 'build-too-old'): string {
  return reason === 'not-windows'
    ? 'Application audio requires Windows.'
    : 'Application audio requires a newer Windows build.';
}

type SourceTab = 'screen' | 'window';

const QUALITY_OPTIONS: readonly ScreenQualityPreset[] = ['standard', 'high', 'smooth', 'smooth720'];

/**
 * Labels only — the underlying constraint values always come from `@disco-voador/media-core`'s
 * exported `SCREEN_QUALITY_PRESETS`, never redefined here, so there is nothing for a future change
 * to that package to silently drift out of sync with.
 */
const QUALITY_LABELS: Record<ScreenQualityPreset, string> = {
  standard: 'Standard 720p30',
  high: 'High 1080p30 (recommended)',
  smooth: 'Smooth 1080p60',
  smooth720: 'Smooth 720p60',
};

const DEFAULT_QUALITY: ScreenQualityPreset = 'high';

export function ScreenSourcePicker({
  onSourceSelected,
  onCancel,
  defaultQuality,
}: ScreenSourcePickerProps): ReactElement {
  const [sources, setSources] = useState<readonly DesktopScreenSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<SourceTab>('screen');
  const [selectedSourceId, setSelectedSourceId] = useState<string | undefined>(undefined);
  const [quality, setQuality] = useState<ScreenQualityPreset>(defaultQuality ?? DEFAULT_QUALITY);
  // T6/T12: 'none' by default — audio is never shared unless the user explicitly opts in for this
  // specific share (see this component's doc comment and docs/architecture/WEBRTC_SCREEN_AUDIO.md).
  const [audioModeChoice, setAudioModeChoice] = useState<'none' | 'system' | 'process'>('none');
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | undefined>(undefined);

  // T12 — capability check only; never spawns the native helper (see `getProcessAudioCapability`'s
  // own doc comment), so this always runs regardless of which audio mode the user ends up picking.
  const [processAudioSupported, setProcessAudioSupported] = useState(false);
  const [processAudioUnsupportedReason, setProcessAudioUnsupportedReason] = useState<
    string | undefined
  >(undefined);

  // T12 — populated only once the user actually selects "Application audio" (never speculatively —
  // mirrors this component's own "no IPC call before it's actually needed" discipline).
  const [processCandidates, setProcessCandidates] = useState<
    readonly DesktopProcessAudioCandidate[]
  >([]);
  const [processCandidatesLoading, setProcessCandidatesLoading] = useState(false);
  const [processCandidatesError, setProcessCandidatesError] = useState<string | undefined>(
    undefined,
  );
  const [selectedPid, setSelectedPid] = useState<number | undefined>(undefined);

  // T12 — set only once `handleShare` has actually armed a process-audio capture selection, so the
  // unmount cleanup below never tears down the very helper session the caller is about to start
  // using (see that effect's own comment).
  const startedProcessAudioShareRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(undefined);

    window.desktopApp
      .listScreenShareSources()
      .then((result) => {
        if (cancelled) return;
        setSources(result);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('screen share: failed to list sources', error);
        setLoadError('Could not list screens/windows to share.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.desktopApp
      .getProcessAudioCapability()
      .then((result) => {
        if (cancelled) return;
        if (result.supported) {
          setProcessAudioSupported(true);
        } else {
          setProcessAudioSupported(false);
          setProcessAudioUnsupportedReason(describeProcessAudioUnsupportedReason(result.reason));
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('screen share: failed to check application-audio capability', error);
        setProcessAudioSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (audioModeChoice !== 'process') return;
    let cancelled = false;
    setProcessCandidatesLoading(true);
    setProcessCandidatesError(undefined);

    window.desktopApp
      .listProcessAudioCandidates()
      .then((result) => {
        if (cancelled) return;
        setProcessCandidatesLoading(false);
        if (!result.supported) {
          setProcessCandidatesError('Application audio is not available on this system.');
          setProcessCandidates([]);
          return;
        }
        setProcessCandidates(result.candidates);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('screen share: failed to list application-audio candidates', error);
        setProcessCandidatesLoading(false);
        setProcessCandidatesError('Could not list running applications.');
      });

    return () => {
      cancelled = true;
    };
  }, [audioModeChoice]);

  // T12 — releases an enumeration-only native helper (one this component's own
  // `listProcessAudioCandidates` calls may have started or reused) if this picker is dismissed
  // without ever starting a real process-audio share — Cancel and every other unmount path (parent
  // re-render, navigating away) all funnel through this same cleanup, matching this component's own
  // "Cancel never has a side effect on an active session" discipline extended to "leaving the picker
  // never leaves a helper process running for no reason."
  useEffect(() => {
    return () => {
      if (!startedProcessAudioShareRef.current) {
        window.desktopApp.cancelProcessAudioEnumeration().catch((error: unknown) => {
          console.error('screen share: failed to cancel application-audio enumeration', error);
        });
      }
    };
  }, []);

  const visibleSources = sources.filter((source) => source.type === activeTab);

  function handleQualityChange(event: ChangeEvent<HTMLSelectElement>): void {
    setQuality(event.target.value as ScreenQualityPreset);
  }

  function handleAudioModeChange(mode: 'none' | 'system' | 'process'): void {
    setAudioModeChoice(mode);
    setSelectedPid(undefined);
  }

  function handleShare(): void {
    if (!selectedSourceId || sharing) return;
    if (audioModeChoice === 'process' && selectedPid === undefined) return;
    setSharing(true);
    setShareError(undefined);

    const shareAudio = audioModeChoice === 'system';

    window.desktopApp
      .selectScreenShareSource(selectedSourceId, shareAudio)
      .then((accepted) => {
        setSharing(false);
        if (!accepted) {
          // Stale/unknown id (e.g. the source closed between enumeration and Share) — never a
          // detailed error from Main, by design (see `main/screen-share.ts`).
          setShareError('That source is no longer available. Refresh and try again.');
          return;
        }
        const audioMode: ScreenShareAudioMode =
          audioModeChoice === 'system'
            ? { type: 'system' }
            : audioModeChoice === 'process' && selectedPid !== undefined
              ? { type: 'process', pid: selectedPid }
              : { type: 'none' };
        if (audioMode.type === 'process') {
          // From this point on, the caller (`VoiceChannelView`/`use-voice-channel.ts`) owns starting
          // and eventually stopping the real capture this `pid` selection commits to — this
          // component's own unmount cleanup must never race that by cancelling the enumeration
          // helper out from under it.
          startedProcessAudioShareRef.current = true;
        }
        onSourceSelected(quality, audioMode);
      })
      .catch((error: unknown) => {
        setSharing(false);
        console.error('screen share: failed to select source', error);
        setShareError('Could not start screen sharing.');
      });
  }

  return (
    <div data-role="screen-source-picker" className={styles.container}>
      <div role="tablist" className={styles.tabs}>
        <button
          type="button"
          data-role="screen-source-tab-screen"
          aria-pressed={activeTab === 'screen'}
          onClick={() => {
            setActiveTab('screen');
          }}
        >
          Screens
        </button>
        <button
          type="button"
          data-role="screen-source-tab-window"
          aria-pressed={activeTab === 'window'}
          onClick={() => {
            setActiveTab('window');
          }}
        >
          Windows
        </button>
      </div>

      {loading && <p>Loading sources…</p>}
      {loadError && <p role="alert">{loadError}</p>}

      {!loading && !loadError && (
        <ul data-role="screen-source-list">
          {visibleSources.map((source) => (
            <li key={source.id}>
              <button
                type="button"
                data-role="screen-source-option"
                data-source-id={source.id}
                aria-pressed={selectedSourceId === source.id}
                onClick={() => {
                  setSelectedSourceId(source.id);
                }}
              >
                {source.thumbnailDataUrl && (
                  <img src={source.thumbnailDataUrl} alt="" width={160} height={90} />
                )}
                {source.appIconDataUrl && (
                  <img src={source.appIconDataUrl} alt="" width={16} height={16} />
                )}
                {/* Source names/titles are untrusted, sensitive text (see docs/SECURITY.md) —
                    rendered as plain text content here, never interpolated into markup/attributes
                    beyond this. */}
                <span>{source.name}</span>
              </button>
            </li>
          ))}
          {visibleSources.length === 0 && (
            <li>No {activeTab === 'screen' ? 'screens' : 'windows'} available.</li>
          )}
        </ul>
      )}

      <label>
        Quality
        <select value={quality} onChange={handleQualityChange}>
          {QUALITY_OPTIONS.map((preset) => (
            <option key={preset} value={preset}>
              {QUALITY_LABELS[preset]}
            </option>
          ))}
        </select>
      </label>

      <fieldset data-role="screen-share-audio-mode">
        <legend>Audio</legend>
        <label>
          <input
            type="radio"
            name="screen-share-audio-mode"
            data-role="screen-share-audio-mode-none"
            checked={audioModeChoice === 'none'}
            onChange={() => {
              handleAudioModeChange('none');
            }}
          />
          No audio
        </label>
        <label>
          <input
            type="radio"
            name="screen-share-audio-mode"
            data-role="screen-share-audio-mode-system"
            checked={audioModeChoice === 'system'}
            onChange={() => {
              handleAudioModeChange('system');
            }}
          />
          System audio
        </label>
        <label>
          <input
            type="radio"
            name="screen-share-audio-mode"
            data-role="screen-share-audio-mode-process"
            checked={audioModeChoice === 'process'}
            disabled={!processAudioSupported}
            onChange={() => {
              handleAudioModeChange('process');
            }}
          />
          Application audio
        </label>
      </fieldset>

      {audioModeChoice === 'system' && (
        // T6 platform finding (see docs/architecture/WEBRTC_SCREEN_AUDIO.md): Windows system-audio
        // loopback captures everything currently playing on the machine, not audio scoped to the
        // selected window — stated plainly here rather than implying window-specific audio.
        <p>Shares all system sound currently playing, not audio from a specific window.</p>
      )}

      {!processAudioSupported && processAudioUnsupportedReason && (
        <p data-role="process-audio-unsupported">{processAudioUnsupportedReason}</p>
      )}

      {audioModeChoice === 'process' && processAudioSupported && (
        <div data-role="process-audio-picker">
          {processCandidatesLoading && <p>Loading running applications…</p>}
          {processCandidatesError && <p role="alert">{processCandidatesError}</p>}
          {!processCandidatesLoading && !processCandidatesError && (
            <label>
              Application
              <select
                data-role="process-audio-select"
                value={selectedPid ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  setSelectedPid(value === '' ? undefined : Number(value));
                }}
              >
                <option value="">Select an application…</option>
                {processCandidates.map((candidate) => (
                  <option key={candidate.pid} value={candidate.pid}>
                    {candidate.displayTitle
                      ? `${candidate.exeName} — ${candidate.displayTitle}`
                      : candidate.exeName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!processCandidatesLoading &&
            !processCandidatesError &&
            processCandidates.length === 0 && <p>No audio-capable applications found.</p>}
        </div>
      )}

      {shareError && <p role="alert">{shareError}</p>}

      <div className={styles.actions}>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="button"
          disabled={
            !selectedSourceId ||
            sharing ||
            (audioModeChoice === 'process' && selectedPid === undefined)
          }
          onClick={handleShare}
        >
          {sharing ? 'Starting…' : 'Share'}
        </Button>
      </div>
    </div>
  );
}

// Re-exported purely so a caller can pass `SCREEN_QUALITY_PRESETS[quality]` straight into
// `acquireScreen()` without a second import from `@disco-voador/media-core` for this one lookup —
// not a redefinition, the values themselves stay owned by `packages/media-core`.
export { SCREEN_QUALITY_PRESETS };
