// @vitest-environment jsdom
//
// T13.4 — "User Volume" (0-200%, live-adjusting) and "Mute for Me"/"Unmute for Me", wired to the
// real production `setParticipantVolume`/`setParticipantLocalMute` actions — never a beautiful dead
// control. Also proves unmuting reads back whatever volume was configured before muting (never
// resets to 100%), and that copy/iconography stays distinct from the self-mute button and from the
// unrelated T13.3 moderator "clear avatar" feature.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ParticipantVoiceControlsModal } from '../../../apps/desktop/src/renderer/workspace/ParticipantVoiceControlsModal.js';
import { createVoiceActions, createVoiceState } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

const TARGET = { participantId: 'participant-1', displayName: 'Alice' };

describe('ParticipantVoiceControlsModal (T13.4)', () => {
  it('renders nothing when no target is set', () => {
    const state = createVoiceState();
    const actions = createVoiceActions();
    render(
      <ParticipantVoiceControlsModal
        target={undefined}
        state={state}
        actions={actions}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('participant-voice-controls-modal')).not.toBeInTheDocument();
  });

  it('defaults to 100% and not muted when no preference has ever been set for this participant', () => {
    const state = createVoiceState();
    const actions = createVoiceActions();
    render(
      <ParticipantVoiceControlsModal
        target={TARGET}
        state={state}
        actions={actions}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('participant-user-volume-slider')).toHaveValue('100');
    expect(screen.getByTestId('participant-local-mute-toggle')).toHaveTextContent(
      'Mute Alice for Me',
    );
  });

  it('dragging the slider calls the real setParticipantVolume action with the exact value', () => {
    const state = createVoiceState();
    const actions = createVoiceActions();
    render(
      <ParticipantVoiceControlsModal
        target={TARGET}
        state={state}
        actions={actions}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('participant-user-volume-slider'), {
      target: { value: '150' },
    });
    expect(actions.setParticipantVolume).toHaveBeenCalledWith('participant-1', 150);
  });

  it('reads back a previously-set volume from state.participantVolumes', () => {
    const state = createVoiceState({
      participantVolumes: new Map([['participant-1', 150]]),
    });
    const actions = createVoiceActions();
    render(
      <ParticipantVoiceControlsModal
        target={TARGET}
        state={state}
        actions={actions}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('participant-user-volume-slider')).toHaveValue('150');
  });

  it('the mute toggle calls the real setParticipantLocalMute action with the toggled value', () => {
    const state = createVoiceState();
    const actions = createVoiceActions();
    render(
      <ParticipantVoiceControlsModal
        target={TARGET}
        state={state}
        actions={actions}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('participant-local-mute-toggle'));
    expect(actions.setParticipantLocalMute).toHaveBeenCalledWith('participant-1', true);
  });

  it('when already muted, shows "Unmute" and reads back the previously-configured volume, never resetting to 100%', () => {
    const state = createVoiceState({
      participantVolumes: new Map([['participant-1', 60]]),
      participantLocalMutes: new Set(['participant-1']),
    });
    const actions = createVoiceActions();
    render(
      <ParticipantVoiceControlsModal
        target={TARGET}
        state={state}
        actions={actions}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('participant-local-mute-toggle')).toHaveTextContent(
      'Unmute Alice for Me',
    );
    // The slider still reflects the real configured volume even while muted (disabled, not hidden).
    expect(screen.getByTestId('participant-user-volume-slider')).toHaveValue('60');
    expect(screen.getByTestId('participant-user-volume-slider')).toBeDisabled();

    fireEvent.click(screen.getByTestId('participant-local-mute-toggle'));
    expect(actions.setParticipantLocalMute).toHaveBeenCalledWith('participant-1', false);
  });

  it('never uses the self-mute wording ("Mute microphone") or references the unrelated moderator "clear avatar" feature', () => {
    const state = createVoiceState();
    const actions = createVoiceActions();
    render(
      <ParticipantVoiceControlsModal
        target={TARGET}
        state={state}
        actions={actions}
        onClose={vi.fn()}
      />,
    );
    const modal = screen.getByTestId('participant-voice-controls-modal');
    expect(modal).not.toHaveTextContent('Mute microphone');
    expect(modal).not.toHaveTextContent('avatar');
  });

  it('closing calls the real onClose callback', () => {
    const state = createVoiceState();
    const actions = createVoiceActions();
    const onClose = vi.fn();
    render(
      <ParticipantVoiceControlsModal
        target={TARGET}
        state={state}
        actions={actions}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
