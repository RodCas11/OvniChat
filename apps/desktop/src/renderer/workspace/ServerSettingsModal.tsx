import { useState, type ReactElement } from 'react';

import { BansSection } from '../voice/BansSection.js';
import { GroupsSection } from '../voice/GroupsSection.js';
import { TokensSection } from '../voice/TokensSection.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import type { ChannelAdminIntent } from './channel-admin-intent.js';
import { ChannelsAdminPage } from './ChannelsAdminPage.js';
import styles from '../voice/SettingsPanel.module.css';

type ServerSettingsSection = 'channels' | 'groups' | 'invites' | 'bans';

const SECTIONS: readonly { readonly id: ServerSettingsSection; readonly label: string }[] = [
  { id: 'channels', label: 'Channels' },
  { id: 'groups', label: 'Groups & Permissions' },
  { id: 'invites', label: 'Invites' },
  { id: 'bans', label: 'Bans' },
];

interface ServerSettingsModalProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly onAdminIntent: (intent: ChannelAdminIntent) => void;
}

/**
 * T13.2 — the Server Admin's own settings shell, mirroring `SettingsPanel.tsx`'s sidebar-nav-with-
 * sections pattern exactly (same `nav`/`navItem`/`navItemActive` classes, reused via that file's own
 * CSS module rather than a parallel one). "Groups & Permissions"/"Invites"/"Bans" mount the exact
 * same `GroupsSection`/`TokensSection`/`BansSection` presentation the pre-existing "Authorization"
 * modal uses (T13.2 extraction — see those components' own doc comments) so this never duplicates
 * any T9 network call; each already self-hides its own content without the relevant permission.
 * "Channels" is the one genuinely new page (item J) — see `ChannelsAdminPage.tsx`.
 *
 * This whole modal's own entry point is itself conditionally rendered by its caller
 * (`VoiceChannelView.tsx`) only for an identity holding at least one channel-admin/groups/tokens/
 * bans capability — a Guest never sees any UI chrome for this at all, matching this task's "hide,
 * don't disable" rule at the entry-point level, not just within each page.
 */
export function ServerSettingsModal({
  state,
  actions,
  onAdminIntent,
}: ServerSettingsModalProps): ReactElement {
  const [activeSection, setActiveSection] = useState<ServerSettingsSection>('channels');

  return (
    <div className={styles.container}>
      <nav className={styles.nav} aria-label="Server settings sections">
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`${styles.navItem} ${
              activeSection === section.id ? styles.navItemActive : ''
            }`}
            aria-current={activeSection === section.id ? 'true' : undefined}
            onClick={() => {
              setActiveSection(section.id);
            }}
            data-testid={`server-settings-nav-${section.id}`}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <div className={styles.content}>
        {activeSection === 'channels' && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Channels</h3>
            <ChannelsAdminPage state={state} actions={actions} onAdminIntent={onAdminIntent} />
          </section>
        )}
        {activeSection === 'groups' && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Groups &amp; Permissions</h3>
            <GroupsSection state={state} actions={actions} />
          </section>
        )}
        {activeSection === 'invites' && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Invites</h3>
            <TokensSection state={state} actions={actions} />
          </section>
        )}
        {activeSection === 'bans' && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Bans</h3>
            <BansSection state={state} actions={actions} />
          </section>
        )}
      </div>
    </div>
  );
}
