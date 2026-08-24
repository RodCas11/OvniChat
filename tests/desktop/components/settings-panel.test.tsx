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
    const { onOutputDeviceChange, actions } = renderSettingsPanel();
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    await screen.findByText('USB Speaker');
    fireEvent.change(screen.getByLabelText('Speaker'), { target: { value: 'speaker-1' } });

    expect(onOutputDeviceChange).toHaveBeenCalledWith('speaker-1');
    // T13.4 — also tells the shared remote-audio graph/join-leave-sound playback which device to
    // route to, mirroring the microphone/camera device-change handlers' own live-action pattern.
    expect(actions.setOutputDevice).toHaveBeenCalledWith('speaker-1');
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

describe('SettingsPanel — T13.4 Input Mode / Push to Talk', () => {
  it('Voice Activity mode shows the sensitivity slider and level meter, never the shortcut control', () => {
    installAudioTestMocks();
    renderSettingsPanel({ state: createVoiceState({ voiceInputMode: 'voice-activity' }) });
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    expect(screen.getByTestId('voice-input-mode-voice-activity')).toBeChecked();
    expect(screen.getByTestId('voice-activity-sensitivity-slider')).toBeInTheDocument();
    expect(screen.getByTestId('voice-activity-level-meter')).toBeInTheDocument();
    expect(screen.queryByTestId('ptt-shortcut-capture-button')).not.toBeInTheDocument();
  });

  it('Push to Talk mode shows the shortcut capture control, never the sensitivity slider', () => {
    renderSettingsPanel({ state: createVoiceState({ voiceInputMode: 'push-to-talk' }) });
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    expect(screen.getByTestId('voice-input-mode-push-to-talk')).toBeChecked();
    expect(screen.getByTestId('ptt-shortcut-capture-button')).toBeInTheDocument();
    expect(screen.queryByTestId('voice-activity-sensitivity-slider')).not.toBeInTheDocument();
  });

  it('selecting Push to Talk calls the real setVoiceInputMode action', () => {
    const { actions } = renderSettingsPanel();
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    fireEvent.click(screen.getByTestId('voice-input-mode-push-to-talk'));
    expect(actions.setVoiceInputMode).toHaveBeenCalledWith('push-to-talk');
  });

  it('adjusting the sensitivity slider calls the real setVoiceActivitySensitivity action', () => {
    installAudioTestMocks();
    const { actions } = renderSettingsPanel({
      state: createVoiceState({ voiceInputMode: 'voice-activity' }),
    });
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    fireEvent.change(screen.getByTestId('voice-activity-sensitivity-slider'), {
      target: { value: '0.8' },
    });
    expect(actions.setVoiceActivitySensitivity).toHaveBeenCalledWith(0.8);
  });

  it('capturing a supported key calls the real setPttShortcut action and shows the registered state', async () => {
    const { actions } = renderSettingsPanel({
      state: createVoiceState({ voiceInputMode: 'push-to-talk' }),
    });
    (actions.setPttShortcut as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    fireEvent.click(screen.getByTestId('ptt-shortcut-capture-button'));
    expect(screen.getByText('Press a key… (Esc to cancel)')).toBeInTheDocument();

    fireEvent.keyDown(window, { code: 'KeyV' });
    expect(actions.setPttShortcut).toHaveBeenCalledWith({
      kind: 'keyboard',
      keycode: 47,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
    await waitFor(() => {
      expect(screen.getByTestId('ptt-shortcut-status')).toHaveTextContent('Shortcut registered');
    });
  });

  it('shows the honest conflict message when setPttShortcut reports a conflict', async () => {
    const { actions } = renderSettingsPanel({
      state: createVoiceState({ voiceInputMode: 'push-to-talk' }),
    });
    (actions.setPttShortcut as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: 'conflict',
      message: 'already registered elsewhere',
    });
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    fireEvent.click(screen.getByTestId('ptt-shortcut-capture-button'));
    fireEvent.keyDown(window, { code: 'KeyV' });

    await waitFor(() => {
      expect(screen.getByTestId('ptt-shortcut-status')).toHaveTextContent(
        'already in use — choose another key',
      );
    });
  });

  // T13.4 QA fix — `result.message` for `'native-module-load-failed'`/`'hook-start-failed'` is an
  // arbitrary, jargon-heavy native-diagnostic string (see `ptt-hotkey-listener.ts`'s own
  // `describeError`), never curated copy. This previously appeared verbatim in the Settings UI (a
  // real QA-caught defect — a raw string like "No native build was found for platform=win32 arch=x64
  // ... loaded from: ...\.vite" is not something a real user should ever see); it must now show a
  // short, honest, jargon-free message instead, while the raw diagnostic is still logged
  // (`console.error`) rather than discarded entirely.
  it.each(['native-module-load-failed', 'hook-start-failed'] as const)(
    'shows curated copy (never the raw native message) when setPttShortcut reports %s',
    async (reason) => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { actions } = renderSettingsPanel({
        state: createVoiceState({ voiceInputMode: 'push-to-talk' }),
      });
      (actions.setPttShortcut as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        reason,
        message: 'SetWindowsHookEx failed',
      });
      fireEvent.click(screen.getByTestId('settings-nav-voice'));

      fireEvent.click(screen.getByTestId('ptt-shortcut-capture-button'));
      fireEvent.keyDown(window, { code: 'KeyV' });

      await waitFor(() => {
        expect(screen.getByTestId('ptt-shortcut-status')).toHaveTextContent(
          'Shortcut unavailable — something went wrong starting the global hotkey listener. Try restarting OvniChat, or contact support if this keeps happening.',
        );
      });
      expect(screen.getByTestId('ptt-shortcut-status')).not.toHaveTextContent(
        'SetWindowsHookEx failed',
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `ptt-shortcut: ${reason}`,
        'SetWindowsHookEx failed',
      );

      consoleErrorSpy.mockRestore();
    },
  );

  it('Escape cancels capture without calling setPttShortcut', () => {
    const { actions } = renderSettingsPanel({
      state: createVoiceState({ voiceInputMode: 'push-to-talk' }),
    });
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    fireEvent.click(screen.getByTestId('ptt-shortcut-capture-button'));
    fireEvent.keyDown(window, { code: 'Escape' });

    expect(actions.setPttShortcut).not.toHaveBeenCalled();
    expect(screen.getByTestId('ptt-shortcut-capture-button')).toHaveTextContent('Press a key…');
  });

  it('an unsupported key keeps capturing rather than silently mis-binding', () => {
    const { actions } = renderSettingsPanel({
      state: createVoiceState({ voiceInputMode: 'push-to-talk' }),
    });
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    fireEvent.click(screen.getByTestId('ptt-shortcut-capture-button'));
    fireEvent.keyDown(window, { code: 'ControlLeft' });

    expect(actions.setPttShortcut).not.toHaveBeenCalled();
    expect(screen.getByText('Press a key… (Esc to cancel)')).toBeInTheDocument();
  });

  it('shows an already-configured shortcut and offers to clear it', () => {
    const { actions } = renderSettingsPanel({
      state: createVoiceState({
        voiceInputMode: 'push-to-talk',
        pttBinding: {
          kind: 'keyboard',
          keycode: 47,
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
        },
      }),
    });
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    expect(screen.getByTestId('ptt-shortcut-capture-button')).toHaveTextContent('V');
    fireEvent.click(screen.getByTestId('ptt-shortcut-clear-button'));
    expect(actions.clearPttShortcut).toHaveBeenCalledTimes(1);
  });

  it('the join/leave sounds toggle calls the real setJoinLeaveSoundsEnabled action', () => {
    const { actions } = renderSettingsPanel({
      state: createVoiceState({ joinLeaveSoundsEnabled: true }),
    });
    fireEvent.click(screen.getByTestId('settings-nav-voice'));

    fireEvent.click(screen.getByTestId('join-leave-sounds-toggle'));
    expect(actions.setJoinLeaveSoundsEnabled).toHaveBeenCalledWith(false);
  });
});
