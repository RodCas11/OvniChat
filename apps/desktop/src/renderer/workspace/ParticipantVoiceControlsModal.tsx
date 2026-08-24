import { type ReactElement } from 'react';
import { MicOff, Volume2 } from 'lucide-react';

import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import { Button } from '../ui/Button.js';
import { Modal } from '../ui/Modal.js';
import styles from './ParticipantVoiceControlsModal.module.css';

export interface ParticipantVoiceControlsTarget {
  readonly participantId: string;
  readonly displayName: string;
}

interface ParticipantVoiceControlsModalProps {
  readonly target: ParticipantVoiceControlsTarget | undefined;
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly onClose: () => void;
}

/**
 * T13.4 — the local, per-participant "User Volume" (0-200%, live-adjusting) and "Mute for Me" /
 * "Unmute for Me" controls, reachable from a participant's row in the joined voice channel (see
 * `ParticipantRow.tsx`'s own entry-point icon button). Deliberately distinct wording/iconography
 * from the user's own self-mute button (`UserControlBar`'s "Mute microphone", a `Mic`/`MicOff`
 * toggle acting on the *local* microphone) and from the unrelated T13.3 moderator "clear avatar"
 * feature (`MemberProfilePopover`'s admin-only action, a completely different capability). Every
 * control here is purely client-local: never sent to any Dedicated Server, never visible to the
 * target participant or anyone else, and never touches `packages/protocol`/`services/realtime` in
 * any way — see `VoiceChannelActions.setParticipantVolume`/`setParticipantLocalMute`'s own doc
 * comments for the full contract, including the disclosed "session-only, not yet persisted by
 * identityId" limitation this UI inherits.
 */
export function ParticipantVoiceControlsModal({
  target,
  state,
  actions,
  onClose,
}: ParticipantVoiceControlsModalProps): ReactElement | null {
  if (!target) return null;

  const volumePercent = state.participantVolumes.get(target.participantId) ?? 100;
  const isLocallyMuted = state.participantLocalMutes.has(target.participantId);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Voice settings for ${target.displayName}`}
      size="small"
      testId="participant-voice-controls-modal"
    >
      <div className={styles.section}>
        <label className={styles.volumeLabel} htmlFor="participant-user-volume">
          <Volume2 size={16} aria-hidden="true" />
          User Volume — {volumePercent}%
        </label>
        <input
          id="participant-user-volume"
          type="range"
          min={0}
          max={200}
          step={5}
          value={volumePercent}
          disabled={isLocallyMuted}
          onChange={(event) => {
            actions.setParticipantVolume(target.participantId, Number(event.target.value));
          }}
          data-testid="participant-user-volume-slider"
        />
        <p className={styles.hint}>
          This only changes how loud {target.displayName} sounds to you — nobody else, including{' '}
          {target.displayName}, is affected or notified.
        </p>
      </div>

      <div className={styles.section}>
        <Button
          variant={isLocallyMuted ? 'primary' : 'secondary'}
          onClick={() => {
            actions.setParticipantLocalMute(target.participantId, !isLocallyMuted);
          }}
          data-testid="participant-local-mute-toggle"
        >
          <MicOff size={14} aria-hidden="true" />
          {isLocallyMuted
            ? `Unmute ${target.displayName} for Me`
            : `Mute ${target.displayName} for Me`}
        </Button>
        <p className={styles.hint}>
          {isLocallyMuted
            ? 'Unmuting restores their previous volume — never resets to 100%.'
            : 'Silences them for you only — this is not the same as their own microphone mute, and never affects anyone else.'}
        </p>
      </div>
    </Modal>
  );
}
