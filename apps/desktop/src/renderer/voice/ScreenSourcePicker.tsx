import { useEffect, useState, type ChangeEvent, type ReactElement } from 'react';

import { SCREEN_QUALITY_PRESETS, type ScreenQualityPreset } from '@disco-voador/media-core';

import type { DesktopScreenSource } from '../../shared/ipc-contract.js';

/**
 * Self-contained screen/window source picker: enumerate → pick one → choose a quality preset →
 * optionally opt into system audio → Share. Never auto-selects anything and never calls
 * `selectScreenShareSource` speculatively — the IPC selection call only happens inside
 * `handleShare`, so Cancel (which never calls it) can never have any side effect on an already-active
 * voice/camera session by construction, not by an extra guard.
 *
 * Prop contract for the caller (`VoiceChannelView.tsx`, wired by the orchestrating engineer, not
 * this component): `onSourceSelected` fires only after `desktopApp.selectScreenShareSource`
 * resolved `true` for the user's chosen source, with the user's chosen `ScreenQualityPreset` and
 * `shareAudio` choice — the caller is expected to then call
 * `acquireScreen(SCREEN_QUALITY_PRESETS[quality], shareAudio)` (from `@disco-voador/media-core`) and
 * publish the resulting track(s); this component does not do that itself. `onCancel` fires when the
 * user dismisses the picker without sharing; it carries no arguments and this component performs no
 * IPC call before invoking it.
 *
 * `shareAudio` defaults to `false` (T6 requirement: never silently share system audio) and is always
 * an explicit user choice, armed alongside the source in the same `selectScreenShareSource` call —
 * see `main/screen-share.ts`.
 */
export interface ScreenSourcePickerProps {
  readonly onSourceSelected: (quality: ScreenQualityPreset, shareAudio: boolean) => void;
  readonly onCancel: () => void;
  /** T11 — pre-selects the quality dropdown from the persisted `screenShare.qualityPreset`
   * preference (`SettingsPanel.tsx`). Only changes this picker's default selection, exactly like
   * today's hardcoded `DEFAULT_QUALITY` did — still never starts a capture by itself, and the user
   * can still freely change it before sharing. Defaults to `'high'` (this module's own prior
   * default) when the caller has not loaded a preference yet. */
  readonly defaultQuality?: ScreenQualityPreset | undefined;
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
  // T6: off by default — system audio is never shared unless the user explicitly opts in for this
  // specific share (see this component's doc comment and docs/architecture/WEBRTC_SCREEN_AUDIO.md).
  const [shareAudio, setShareAudio] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | undefined>(undefined);

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

  const visibleSources = sources.filter((source) => source.type === activeTab);

  function handleQualityChange(event: ChangeEvent<HTMLSelectElement>): void {
    setQuality(event.target.value as ScreenQualityPreset);
  }

  function handleShare(): void {
    if (!selectedSourceId || sharing) return;
    setSharing(true);
    setShareError(undefined);

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
        onSourceSelected(quality, shareAudio);
      })
      .catch((error: unknown) => {
        setSharing(false);
        console.error('screen share: failed to select source', error);
        setShareError('Could not start screen sharing.');
      });
  }

  return (
    <section data-role="screen-source-picker">
      <h3>Share your screen</h3>

      <div role="tablist">
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

      <label>
        <input
          type="checkbox"
          data-role="screen-share-audio-checkbox"
          checked={shareAudio}
          onChange={(event) => {
            setShareAudio(event.target.checked);
          }}
        />
        Share audio
      </label>
      {/* T6 platform finding (see docs/architecture/WEBRTC_SCREEN_AUDIO.md): Windows system-audio
          loopback captures everything currently playing on the machine, not audio scoped to the
          selected window — stated plainly here rather than implying window-specific audio. */}
      <p>Shares all system sound currently playing, not audio from a specific window.</p>

      {shareError && <p role="alert">{shareError}</p>}

      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" disabled={!selectedSourceId || sharing} onClick={handleShare}>
        {sharing ? 'Starting…' : 'Share'}
      </button>
    </section>
  );
}

// Re-exported purely so a caller can pass `SCREEN_QUALITY_PRESETS[quality]` straight into
// `acquireScreen()` without a second import from `@disco-voador/media-core` for this one lookup —
// not a redefinition, the values themselves stay owned by `packages/media-core`.
export { SCREEN_QUALITY_PRESETS };
