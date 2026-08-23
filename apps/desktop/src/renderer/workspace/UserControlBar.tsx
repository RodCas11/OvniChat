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
          active={state.muted}
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
