import { useCallback, useState, type ReactElement } from 'react';

import { Avatar } from '../ui/Avatar.js';
import { Button } from '../ui/Button.js';
import { ServerAvatar } from '../ui/ServerAvatar.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import { describeProfileError } from './profile-error-copy.js';
import styles from './ChannelAdminForm.module.css';

interface ServerProfileSectionProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
}

/** 1024x1024 — the server-avatar pixel-dimension ceiling (`packages/protocol/src/profile.ts`). */
const SERVER_AVATAR_MAX_DIMENSION = 1024;

/**
 * T13.3 — server avatar Change/Remove, gated on `server.manage` by this component's own caller
 * (`ServerSettingsModal.tsx`, which hides the whole "Server Profile" nav entry — not just disables
 * it — for a caller without the permission, matching this app's established honest-limits
 * convention).
 *
 * **Known protocol gap, worked around here rather than guessed past**: `client:profile-set-avatar`/
 * `client:profile-clear-avatar` targeting `'server'` only ever reply with the *actor's own*
 * `server:profile-self-updated` snapshot — never the server's new `avatarRef` — and there is no live
 * broadcast of a server-avatar change to any connection at all (only a future `server:hello` would
 * see it, i.e. a fresh connect/reconnect). So after a successful set/clear, this component shows the
 * bytes it just uploaded (or the initials fallback, for a clear) as a local, explicitly-labeled
 * optimistic preview — real data this component already has, never fabricated — rather than
 * attempting to force a fake `avatarRef`/hash into `state.avatarCache`, which would require
 * duplicating the server's own sha256 hashing client-side. This preview is intentionally not
 * persisted anywhere and does not survive a reconnect.
 */
export function ServerProfileSection({ state, actions }: ServerProfileSectionProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** `undefined`: no local override, render from `state.serverInfo.serverAvatarRef` as usual.
   * `null`: just cleared. A string: just uploaded, this exact `data:` URI. */
  const [localPreview, setLocalPreview] = useState<string | null | undefined>(undefined);

  const serverName = state.serverInfo?.serverName ?? 'This server';

  const requestServerAvatar = useCallback(() => {
    actions.requestAvatar('server');
  }, [actions]);

  const handleChange = useCallback(() => {
    setError(undefined);
    setBusy(true);
    void (async () => {
      try {
        const picked = await window.desktopApp.selectAvatarImageFile(SERVER_AVATAR_MAX_DIMENSION);
        if (!picked) return;
        if (!picked.ok) {
          setError(picked.message);
          return;
        }
        await actions.setAvatar('server', picked.format, picked.base64);
        setLocalPreview(`data:image/${picked.format};base64,${picked.base64}`);
      } catch (thrown) {
        setError(describeProfileError(thrown));
      } finally {
        setBusy(false);
      }
    })();
  }, [actions]);

  const handleRemove = useCallback(() => {
    setError(undefined);
    setBusy(true);
    actions
      .clearServerAvatar()
      .then(() => {
        setLocalPreview(null);
      })
      .catch((thrown: unknown) => {
        setError(describeProfileError(thrown));
      })
      .finally(() => {
        setBusy(false);
      });
  }, [actions]);

  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>Server Profile</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chantivo-space-4)' }}>
        {localPreview === undefined ? (
          <ServerAvatar
            serverName={serverName}
            size="large"
            shape="square"
            avatarRef={state.serverInfo?.serverAvatarRef}
            avatarCache={state.avatarCache}
            onRequestAvatar={requestServerAvatar}
          />
        ) : (
          <Avatar
            name={serverName}
            size="large"
            shape="square"
            {...(localPreview !== null ? { imageUrl: localPreview } : {})}
          />
        )}
        <div style={{ display: 'flex', gap: 'var(--chantivo-space-2)' }}>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={handleChange}
            data-testid="server-profile-change-avatar"
          >
            Change
          </Button>
          {(localPreview !== undefined
            ? localPreview !== null
            : state.serverInfo?.serverAvatarRef) && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={handleRemove}
              data-testid="server-profile-remove-avatar"
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {localPreview !== undefined && (
        <p className={styles.hint}>
          Showing your just-uploaded change locally — other members will see it after their next
          reconnect.
        </p>
      )}
    </div>
  );
}
