import type { ReactElement } from 'react';

import type { DesktopE2EVoiceConfig, DesktopIdentity } from '../../shared/ipc-contract.js';
import type { VoiceChannelConnectionConfig } from '../voice/use-voice-channel.js';
import { VoiceChannelView } from '../voice/VoiceChannelView.js';
import { ServerRail } from './ServerRail.js';
import styles from './AppShell.module.css';

interface AppShellProps {
  readonly realtimeConfig: VoiceChannelConnectionConfig;
  readonly e2eAutoJoin: DesktopE2EVoiceConfig | undefined;
  readonly defaultDisplayName: string;
  readonly identity: DesktopIdentity;
  readonly nickname: string;
  readonly onNicknameChange: (nickname: string) => Promise<boolean>;
  readonly onRegenerateIdentity: () => Promise<void>;
  readonly activeServerAddress: string | undefined;
  readonly onSwitchServer: (url: string) => void;
  readonly onGoHome: () => void;
}

/**
 * The connected-workspace root (T13.1). `App.tsx` mounts this with a `key` that changes on every
 * new connection sequence (see `App.tsx`'s own `connectionSequenceRef` doc comment) — because React
 * 19 batches `disconnect()` + `connectTo()` state updates from a single "switch server" handler into
 * one commit, the connected branch can go straight from one `AppShell` render to another without an
 * intermediate disconnected render ever happening; without a changing `key`, React would keep
 * reusing the *same* `AppShell`/`VoiceChannelView` component instance across that switch, silently
 * leaking local UI state (draft chat text, selected channel, open settings panel, device-picker
 * selections) from the old server into the new one. A changing `key` forces React to fully unmount
 * the old instance and mount a fresh one instead, on every switch, by construction — not merely
 * "usually" via a timing coincidence.
 *
 * Composes `ServerRail` (bookmarks, switch/home actions) alongside `VoiceChannelView`, which — its
 * own hook/effect ownership entirely unchanged from before this task — now renders the redesigned
 * channel sidebar / chat / member panel / user control bar layout in place of T0-T12's plain
 * unstyled markup.
 */
export function AppShell({
  realtimeConfig,
  e2eAutoJoin,
  defaultDisplayName,
  identity,
  nickname,
  onNicknameChange,
  onRegenerateIdentity,
  activeServerAddress,
  onSwitchServer,
  onGoHome,
}: AppShellProps): ReactElement {
  return (
    <div className={styles.shell}>
      <ServerRail
        activeServerAddress={activeServerAddress}
        onSwitchServer={onSwitchServer}
        onGoHome={onGoHome}
      />
      <VoiceChannelView
        realtimeConfig={realtimeConfig}
        e2eAutoJoin={e2eAutoJoin}
        defaultDisplayName={defaultDisplayName}
        identity={identity}
        nickname={nickname}
        onNicknameChange={onNicknameChange}
        onRegenerateIdentity={onRegenerateIdentity}
      />
    </div>
  );
}
