// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UserControlBar } from '../../../apps/desktop/src/renderer/workspace/UserControlBar.js';
import { createVoiceActions, createVoiceState } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

function renderBar(
  stateOverrides: Partial<Parameters<typeof createVoiceState>[0]> = {},
  extra: Partial<Parameters<typeof UserControlBar>[0]> = {},
) {
  const actions = createVoiceActions();
  const onOpenSettings = vi.fn();
  const onOpenScreenPicker = vi.fn();
  const state = createVoiceState({ currentChannelId: 'general', ...stateOverrides });

  const result = render(
    <UserControlBar
      state={state}
      actions={actions}
      displayName="Alice"
      onOpenSettings={onOpenSettings}
      onOpenScreenPicker={onOpenScreenPicker}
      {...extra}
    />,
  );
  return { ...result, actions, onOpenSettings, onOpenScreenPicker, state };
}

describe('UserControlBar (T13.1)', () => {
  it('mic button calls the real setMuted action with the toggled value, not internal fake state', () => {
    const { actions } = renderBar({ muted: false });
    fireEvent.click(screen.getByTestId('user-control-mic'));
    expect(actions.setMuted).toHaveBeenCalledWith(true);

    cleanup();
    const { actions: actions2 } = renderBar({ muted: true });
    fireEvent.click(screen.getByTestId('user-control-mic'));
    expect(actions2.setMuted).toHaveBeenCalledWith(false);
  });

  it('deafen button calls the real setDeafened action with the toggled value', () => {
    const { actions } = renderBar({ deafened: false });
    fireEvent.click(screen.getByTestId('user-control-deafen'));
    expect(actions.setDeafened).toHaveBeenCalledWith(true);
  });

  it('camera button calls enableCamera/disableCamera based on real state, not local toggling', () => {
    const { actions } = renderBar({ cameraEnabled: false });
    fireEvent.click(screen.getByTestId('user-control-camera'));
    expect(actions.enableCamera).toHaveBeenCalledTimes(1);
    expect(actions.disableCamera).not.toHaveBeenCalled();

    cleanup();
    const { actions: actions2 } = renderBar({ cameraEnabled: true });
    fireEvent.click(screen.getByTestId('user-control-camera'));
    expect(actions2.disableCamera).toHaveBeenCalledTimes(1);
    expect(actions2.enableCamera).not.toHaveBeenCalled();
  });

  it('screen button opens the picker when idle, and stops sharing (real action) when already sharing', () => {
    const { onOpenScreenPicker, actions } = renderBar({ screenSharingState: 'idle' });
    fireEvent.click(screen.getByTestId('user-control-screen'));
    expect(onOpenScreenPicker).toHaveBeenCalledTimes(1);
    expect(actions.disableScreenShare).not.toHaveBeenCalled();

    cleanup();
    const { actions: actions2, onOpenScreenPicker: onOpenScreenPicker2 } = renderBar({
      screenSharingState: 'sharing',
    });
    fireEvent.click(screen.getByTestId('user-control-screen'));
    expect(actions2.disableScreenShare).toHaveBeenCalledTimes(1);
    expect(onOpenScreenPicker2).not.toHaveBeenCalled();
  });

  it('settings button calls the real onOpenSettings callback', () => {
    const { onOpenSettings } = renderBar();
    fireEvent.click(screen.getByTestId('user-control-settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('reflects muted/deafened/camera-on/sharing state with more than color alone (aria-pressed + icon swap)', () => {
    renderBar({ muted: true, deafened: true, cameraEnabled: true, screenSharingState: 'sharing' });

    expect(screen.getByTestId('user-control-mic')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('user-control-deafen')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('user-control-camera')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('user-control-screen')).toHaveAttribute('aria-pressed', 'true');
    // Icon swap: unmuting/undeafening labels prove the icon (and not merely a CSS class) changed.
    expect(screen.getByTestId('user-control-mic')).toHaveAccessibleName('Unmute microphone');
    expect(screen.getByTestId('user-control-deafen')).toHaveAccessibleName('Undeafen');
  });

  it('reflects the inactive state distinctly when nothing is toggled on', () => {
    renderBar({ muted: false, deafened: false, cameraEnabled: false, screenSharingState: 'idle' });

    expect(screen.getByTestId('user-control-mic')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('user-control-mic')).toHaveAccessibleName('Mute microphone');
    expect(screen.getByTestId('user-control-screen')).toHaveAccessibleName('Share your screen');
  });

  it('every icon-only control button has a real accessible name and a visible tooltip on hover', () => {
    renderBar();
    for (const testId of [
      'user-control-mic',
      'user-control-deafen',
      'user-control-camera',
      'user-control-screen',
      'user-control-settings',
    ]) {
      const button = screen.getByTestId(testId);
      const accessibleName = button.getAttribute('aria-label');
      expect(accessibleName).toBeTruthy();

      const wrapper = button.closest('span') ?? button;
      fireEvent.mouseEnter(wrapper);
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toHaveTextContent(accessibleName ?? '');
      fireEvent.mouseLeave(wrapper);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    }
  });

  it('disables mic/deafen/camera/screen controls while not in a voice channel (currentChannelId undefined)', () => {
    renderBar({ currentChannelId: undefined });
    expect(screen.getByTestId('user-control-mic')).toBeDisabled();
    expect(screen.getByTestId('user-control-deafen')).toBeDisabled();
    expect(screen.getByTestId('user-control-camera')).toBeDisabled();
    expect(screen.getByTestId('user-control-screen')).toBeDisabled();
    // Settings remains available regardless of voice-join status.
    expect(screen.getByTestId('user-control-settings')).not.toBeDisabled();
  });
});
