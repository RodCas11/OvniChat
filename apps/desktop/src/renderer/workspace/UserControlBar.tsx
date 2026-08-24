import type { ReactElement } from 'react';
import {
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  Settings,
  Video,
  VideoOff,
} from 'lucide-react';

import { UserAvatar } from '../ui/UserAvatar.js';
import { IconButton } from '../ui/IconButton.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import styles from './UserControlBar.module.css';

interface UserControlBarProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly displayName: string;
  readonly onOpenSettings: () => void;
  readonly onOpenScreenPicker: () => void;
  /** T13.3 — opens the Profile Editor (own avatar, custom status, presence). */
  readonly onOpenProfile: () => void;
}

const PRESENCE_DOT_CLASS: Record<'online' | 'away' | 'dnd', string> = {
  online: 'presenceOnline',
  away: 'presenceAway',
  dnd: 'presenceDnd',
};

/**
 * Bottom-persistent bar (T13.1) — wired to the existing, real mic-mute/deafen/camera/screen-share/
 * settings actions from `use-voice-channel.ts`/`VoiceChannelView.tsx`; never creates new state and
 * never visually toggles unless the real production state actually changed. Strong, non-color-only
 * treatment for muted/deafened/camera-on/sharing (a filled/danger icon swap, not merely a color
 * change) — see each `IconButton`'s `active`/`danger` usage below.
 */
/**
 * T13.4 — a short, human-readable status suffix appended after the mic button's own accessible
 * name (never replacing it — see this file's own doc comment on why `ariaLabel` itself must stay
 * exactly "Mute microphone"/"Unmute microphone") so PTT-held/Voice-Activity-listening/no-input-device
 * states are immediately legible via the button's tooltip, distinct from merely "is currently
 * speaking" (never claimed here — that indicator lives on the avatar itself, see `ParticipantRow`/
 * `MemberRow`'s speaking ring).
 */
function micStatusDetail(state: VoiceChannelState): string {
  if (state.micDisconnected) return 'Microphone disconnected';
  if (state.muted) return 'Muted';
  if (state.voiceInputMode === 'push-to-talk') {
    return state.pttHeld
      ? 'Push to Talk — transmitting'
      : 'Push to Talk — hold your shortcut to talk';
  }
  return state.selfVoiceActivityDetected
    ? 'Voice Activity — transmitting'
    : 'Voice Activity — listening';
}

export function UserControlBar({
  state,
  actions,
  displayName,
  onOpenSettings,
  onOpenScreenPicker,
  onOpenProfile,
}: UserControlBarProps): ReactElement {
  const inChannel = Boolean(state.currentChannelId);
  const presenceDotClass = styles[PRESENCE_DOT_CLASS[state.selfPresence]];
  // T13.4 — the mic control turns green (the same `active` treatment already used for camera-on/
  // sharing) the instant the configured PTT key is physically held, *separate* from the muted/danger
  // (red) treatment below — deliberately distinct, immediate visual feedback from "is actually
  // speaking" (product spec: this is "PTT is currently open", not "voice energy detected").
  const pttHeldIndicator =
    inChannel && state.voiceInputMode === 'push-to-talk' && state.pttHeld && !state.muted;
  const micTooltip = `${state.muted ? 'Unmute microphone' : 'Mute microphone'} — ${micStatusDetail(state)}`;

  return (
    <div className={styles.bar}>
      <button
        type="button"
        className={styles.identityButton}
        onClick={onOpenProfile}
        aria-label="Open your profile"
        data-testid="user-control-open-profile"
      >
        <span className={styles.avatarWrap}>
          <UserAvatar
            name={displayName}
            avatarRef={state.selfAvatarRef}
            avatarCache={state.avatarCache}
            onRequestAvatar={() => {
              actions.requestAvatar('self');
            }}
          />
          {presenceDotClass && (
            <span className={`${styles.presenceDot} ${presenceDotClass}`} aria-hidden="true" />
          )}
        </span>
        <div className={styles.names}>
          <span className={styles.displayName}>{displayName}</span>
          {state.selfCustomStatus ? (
            <span className={styles.customStatus}>{state.selfCustomStatus}</span>
          ) : (
            <span className={styles.connectionStatus}>{state.connectionStatus}</span>
          )}
        </div>
      </button>

      <div className={styles.controls}>
        <IconButton
          icon={state.muted ? MicOff : Mic}
          ariaLabel={state.muted ? 'Unmute microphone' : 'Mute microphone'}
          tooltip={micTooltip}
          active={state.muted || pttHeldIndicator}
          danger={state.muted}
          disabled={!inChannel}
          onClick={() => {
            actions.setMuted(!state.muted);
          }}
          data-testid="user-control-mic"
        />
        <IconButton
          icon={state.deafened ? HeadphoneOff : Headphones}
          ariaLabel={state.deafened ? 'Undeafen' : 'Deafen'}
          active={state.deafened}
          danger={state.deafened}
          disabled={!inChannel}
          onClick={() => {
            actions.setDeafened(!state.deafened);
          }}
          data-testid="user-control-deafen"
        />
        <IconButton
          icon={state.cameraEnabled ? VideoOff : Video}
          ariaLabel={state.cameraEnabled ? 'Turn off camera' : 'Turn on camera'}
          active={state.cameraEnabled}
          disabled={!inChannel || state.cameraAcquiring}
          onClick={() => {
            if (state.cameraEnabled) actions.disableCamera();
            else actions.enableCamera();
          }}
          data-testid="user-control-camera"
        />
        <IconButton
          icon={state.screenSharingState === 'sharing' ? MonitorOff : Monitor}
          ariaLabel={
            state.screenSharingState === 'sharing'
              ? 'Stop sharing your screen'
              : 'Share your screen'
          }
          active={state.screenSharingState === 'sharing'}
          disabled={!inChannel || state.screenSharingState === 'starting'}
          onClick={() => {
            if (state.screenSharingState === 'sharing') actions.disableScreenShare();
            else onOpenScreenPicker();
          }}
          data-testid="user-control-screen"
        />
        <IconButton
          icon={Settings}
          ariaLabel="Open settings"
          onClick={onOpenSettings}
          data-testid="user-control-settings"
        />
      </div>
    </div>
  );
}
