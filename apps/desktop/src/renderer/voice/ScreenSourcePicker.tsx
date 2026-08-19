import { useEffect, useState, type ChangeEvent, type ReactElement } from 'react';

import { SCREEN_QUALITY_PRESETS, type ScreenQualityPreset } from '@disco-voador/media-core';

import type { DesktopScreenSource } from '../../shared/ipc-contract.js';

/**
 * Self-contained screen/window source picker: enumerate → pick one → choose a quality preset →
 * Share. Never auto-selects anything and never calls `selectScreenShareSource` speculatively — the
 * IPC selection call only happens inside `handleShare`, so Cancel (which never calls it) can never
 * have any side effect on an already-active voice/camera session by construction, not by an extra
 * guard.
 *
 * Prop contract for the caller (`VoiceChannelView.tsx`, wired by the orchestrating engineer, not
 * this component): `onSourceSelected` fires only after `desktopApp.selectScreenShareSource`
 * resolved `true` for the user's chosen source, with the user's chosen `ScreenQualityPreset` — the
 * caller is expected to then call `acquireScreen(SCREEN_QUALITY_PRESETS[quality])` (from
 * `@disco-voador/media-core`) and publish the resulting track; this component does not do that
 * itself. `onCancel` fires when the user dismisses the picker without sharing; it carries no
 * arguments and this component performs no IPC call before invoking it.
 */
export interface ScreenSourcePickerProps {
  readonly onSourceSelected: (quality: ScreenQualityPreset) => void;
  readonly onCancel: () => void;
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
}: ScreenSourcePickerProps): ReactElement {
  const [sources, setSources] = useState<readonly DesktopScreenSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<SourceTab>('screen');
  const [selectedSourceId, setSelectedSourceId] = useState<string | undefined>(undefined);
  const [quality, setQuality] = useState<ScreenQualityPreset>(DEFAULT_QUALITY);
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
      .selectScreenShareSource(selectedSourceId)
      .then((accepted) => {
        setSharing(false);
        if (!accepted) {
          // Stale/unknown id (e.g. the source closed between enumeration and Share) — never a
          // detailed error from Main, by design (see `main/screen-share.ts`).
          setShareError('That source is no longer available. Refresh and try again.');
          return;
        }
        onSourceSelected(quality);
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
