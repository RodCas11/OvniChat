// @vitest-environment jsdom
//
// T13.1.1 QA: `SettingsPanel.tsx` was redesigned into a sidebar-navigation layout across four
// truthful sections (Profile / Voice & Video / Screen Share / Advanced). No test for this component
// existed before T13.1.1 (it lives in `voice/`, outside T13.1's own `workspace/`/`shell/`-focused
// suite) — this file is new, focused specifically on the redesign's information architecture and on
// proving every device/quality control still wires to its real production action (never a beautiful
// dead control).
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsPanel } from '../../../apps/desktop/src/renderer/voice/SettingsPanel.js';
import { createIdentity, installDesktopAppMock } from '../fixtures/desktop-app-mock.js';
import { createVoiceActions, createVoiceState } from '../fixtures/voice-state.js';

const FAKE_DEVICES: readonly Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[] = [
  { deviceId: 'mic-1', kind: 'audioinput', label: 'USB Microphone' },
  { deviceId: 'speaker-1', kind: 'audiooutput', label: 'USB Speaker' },
  { deviceId: 'camera-1', kind: 'videoinput', label: 'USB Camera' },
];

function installMediaDevicesMock(): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn().mockResolvedValue(FAKE_DEVICES as unknown as MediaDeviceInfo[]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [] as MediaStreamTrack[],
      } as unknown as MediaStream),
    },
  });
}

/** A minimal, deterministic stand-in for the Web Audio graph `SettingsPanel.tsx` builds for the mic
 * level meter and the output test tone — jsdom implements neither `AudioContext` nor
 * `HTMLMediaElement.prototype.play`/`requestAnimationFrame`, so a real graph is neither available nor
 * necessary to prove these controls call into the real production code path without crashing. */
class FakeAudioContext {
  createMediaStreamSource(): { connect: () => void } {
    return { connect: vi.fn() };
  }
  createAnalyser(): {
    fftSize: number;
    frequencyBinCount: number;
    getByteTimeDomainData: (buffer: Uint8Array) => void;
  } {
    return {
      fftSize: 512,
      frequencyBinCount: 256,
      getByteTimeDomainData: (buffer: Uint8Array) => {
        buffer.fill(128);
      },
    };
  }
  createOscillator(): {
    frequency: { value: number };
    connect: () => void;
    start: () => void;
    stop: () => void;
  } {
    return { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  }
  createGain(): { gain: { value: number }; connect: () => void } {
    return { gain: { value: 0 }, connect: vi.fn() };
  }
  createMediaStreamDestination(): { stream: MediaStream } {
    return { stream: {} as MediaStream };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function installAudioTestMocks(): void {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  // A single-shot fake — never invokes the callback, so the mic meter's recursive
  // `requestAnimationFrame(tick)` loop runs exactly once per test instead of looping forever.
  vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
}

function renderSettingsPanel(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const actions = createVoiceActions();
  const state = createVoiceState();
  const onOutputDeviceChange = vi.fn();
  const onScreenQualityPresetChange = vi.fn();
  const onNicknameChange = vi.fn().mockResolvedValue(true);
  const onRegenerateIdentity = vi.fn().mockResolvedValue(undefined);
  const onVoiceDisplayNameChange = vi.fn();

  const props: Parameters<typeof SettingsPanel>[0] = {
    state,
    actions,
    outputDeviceId: null,
    onOutputDeviceChange,
    screenQualityPreset: 'high',
    onScreenQualityPresetChange,
    outputDeviceSelectionSupported: true,
    identity: createIdentity(),
    nickname: 'Nova',
    onNicknameChange,
    onRegenerateIdentity,
    voiceDisplayName: 'Nova the Bold',
    onVoiceDisplayNameChange,
    ...overrides,
  };

  const result = render(<SettingsPanel {...props} />);
  return {
    ...result,
    actions,
    state,
    onOutputDeviceChange,
    onScreenQualityPresetChange,
    onNicknameChange,
    onRegenerateIdentity,
    onVoiceDisplayNameChange,
  };
}

beforeEach(() => {
  installDesktopAppMock();
  installMediaDevicesMock();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SettingsPanel (T13.1.1 redesign) — sidebar navigation', () => {
  it('renders exactly the four truthful sections — Profile, Voice & Video, Screen Share, Advanced — never a fabricated "Appearance" section', () => {
    renderSettingsPanel();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav).toHaveTextContent('Profile');
    expect(nav).toHaveTextContent('Voice & Video');
    expect(nav).toHaveTextContent('Screen Share');
    expect(nav).toHaveTextContent('Advanced');
    expect(nav).not.toHaveTextContent('Appearance');
    expect(screen.getByTestId('settings-nav-profile')).toBeInTheDocument();
    expect(screen.getByTestId('settings-nav-voice')).toBeInTheDocument();
    expect(screen.getByTestId('settings-nav-screen')).toBeInTheDocument();
    expect(screen.getByTestId('settings-nav-advanced')).toBeInTheDocument();
  });

  it('defaults to the Profile section and shows only its real content', () => {
    renderSettingsPanel();
    expect(screen.getByTestId('settings-nav-profile')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Voice display name')).toBeInTheDocument();
    expect(screen.queryByLabelText('Microphone')).not.toBeInTheDocument();
    expect(screen.queryByText('Identity ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Default quality')).not.toBeInTheDocument();
  });

  it("clicking Voice & Video shows only that section's content and hides the others", () => {
    renderSettingsPanel();
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    expect(screen.getByTestId('settings-nav-voice')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('Microphone')).toBeInTheDocument();
    expect(screen.getByLabelText('Speaker')).toBeInTheDocument();
    expect(screen.getByLabelText('Camera')).toBeInTheDocument();
    expect(screen.queryByLabelText('Voice display name')).not.toBeInTheDocument();
    expect(screen.queryByText('Identity ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Default quality')).not.toBeInTheDocument();
  });

  it("clicking Screen Share shows only that section's content", () => {
    renderSettingsPanel();
    fireEvent.click(screen.getByTestId('settings-nav-screen'));

    expect(screen.getByText('Default quality')).toBeInTheDocument();
    expect(screen.queryByLabelText('Microphone')).not.toBeInTheDocument();
    expect(screen.queryByText('Identity ID')).not.toBeInTheDocument();
  });

  it('clicking Advanced shows Identity/Diagnostics content, and Identity ID / Regenerate Identity render ONLY there — never under Profile', () => {
    renderSettingsPanel();
    // Not present under the default Profile section.
    expect(screen.queryByText('Identity ID')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate Identity' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('settings-nav-advanced'));

    expect(screen.getByText('Identity ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate Identity' })).toBeInTheDocument();
    expect(screen.getByText('Electron')).toBeInTheDocument();
    // Still not leaking into the other sections' content.
    expect(screen.queryByLabelText('Microphone')).not.toBeInTheDocument();
    expect(screen.queryByText('Default quality')).not.toBeInTheDocument();
  });
});

describe('SettingsPanel (T13.1.1) — controls still wire to their real production actions', () => {
  it('selecting a microphone calls the real switchMicrophone action and persists the preference', async () => {
    const { actions } = renderSettingsPanel();
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    // `useMediaDevices` populates the real device list asynchronously (`enumerateDevices()` is a
    // Promise) — wait for the real "mic-1" option to actually exist before selecting it, otherwise
    // the <select> silently has nothing to select and the change event fires with the empty/default
    // value instead.
    await screen.findByText('USB Microphone');
    fireEvent.change(screen.getByLabelText('Microphone'), { target: { value: 'mic-1' } });

    expect(actions.switchMicrophone).toHaveBeenCalledWith('mic-1');
    await waitFor(() => {
      expect(window.desktopApp.updateClientSettings).toHaveBeenCalledWith({
        audio: { inputDeviceId: 'mic-1' },
      });
    });
  });

  it('selecting a camera calls the real switchCamera action and persists the preference', async () => {
    const { actions } = renderSettingsPanel();
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    await screen.findByText('USB Camera');
    fireEvent.change(screen.getByLabelText('Camera'), { target: { value: 'camera-1' } });

    expect(actions.switchCamera).toHaveBeenCalledWith('camera-1');
    await waitFor(() => {
      expect(window.desktopApp.updateClientSettings).toHaveBeenCalledWith({
        video: { cameraDeviceId: 'camera-1' },
      });
    });
  });

  it('selecting a speaker calls the real onOutputDeviceChange callback and persists the preference', async () => {
    const { onOutputDeviceChange } = renderSettingsPanel();
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    await screen.findByText('USB Speaker');
    fireEvent.change(screen.getByLabelText('Speaker'), { target: { value: 'speaker-1' } });

    expect(onOutputDeviceChange).toHaveBeenCalledWith('speaker-1');
    await waitFor(() => {
      expect(window.desktopApp.updateClientSettings).toHaveBeenCalledWith({
        audio: { outputDeviceId: 'speaker-1' },
      });
    });
  });

  it('disables the speaker selector and test tone, with an explanatory hint, when output device selection is unsupported', () => {
    renderSettingsPanel({ outputDeviceSelectionSupported: false });
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    expect(screen.getByLabelText('Speaker')).toBeDisabled();
    expect(
      screen.getByText('Speaker selection is not supported on this build.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play test tone' })).toBeDisabled();
  });

  it('selecting a screen-share quality preset calls the real onScreenQualityPresetChange callback and persists it', async () => {
    const { onScreenQualityPresetChange } = renderSettingsPanel();
    fireEvent.click(screen.getByTestId('settings-nav-screen'));

    fireEvent.change(screen.getByLabelText('Default quality'), { target: { value: 'smooth' } });

    expect(onScreenQualityPresetChange).toHaveBeenCalledWith('smooth');
    await waitFor(() => {
      expect(window.desktopApp.updateClientSettings).toHaveBeenCalledWith({
        screenShare: { qualityPreset: 'smooth' },
      });
    });
  });

  it('"Test microphone" genuinely starts the real mic-level-meter flow (acquires a microphone via getUserMedia when no call is active) rather than being a dead control', async () => {
    installAudioTestMocks();
    renderSettingsPanel();
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    fireEvent.click(screen.getByRole('button', { name: 'Test microphone' }));

    expect(screen.getByRole('button', { name: 'Stop microphone test' })).toBeInTheDocument();
    await waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop microphone test' }));
    expect(screen.getByRole('button', { name: 'Test microphone' })).toBeInTheDocument();
  });

  it('"Play test tone" genuinely starts and stops real audio playback (not a dead control)', () => {
    installAudioTestMocks();
    renderSettingsPanel();
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    fireEvent.click(screen.getByRole('button', { name: 'Play test tone' }));
    expect(screen.getByRole('button', { name: 'Stop test tone' })).toBeInTheDocument();
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop test tone' }));
    expect(screen.getByRole('button', { name: 'Play test tone' })).toBeInTheDocument();
  });
});
