import { useEffect, useState, type ReactElement } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';

import type { DesktopIdentity } from '../../shared/ipc-contract.js';
import { Button } from '../ui/Button.js';
import styles from './IdentityPanel.module.css';

interface IdentityPanelProps {
  readonly nickname: string;
  readonly identity: DesktopIdentity;
  readonly onNicknameChange: (nickname: string) => Promise<boolean>;
  readonly onRegenerate: () => Promise<void>;
  /** Security review (T13.1.1): `false` (default) preserves this component's original behavior,
   * used by `SettingsPanel.tsx`'s own `Advanced` section — Identity ID and Regenerate Identity
   * render immediately, since reaching this component there already required navigating into
   * Advanced. `true` additionally collapses the Identity ID / Regenerate Identity block behind its
   * own closed-by-default disclosure (mirroring `AddServerDialog.tsx`'s existing Advanced toggle) —
   * used by `ServerHome.tsx`'s disconnected "Profile" modal, which has no separate Advanced tab to
   * gate this behind, so it needs its own explicit extra step per the task's "identity must not be
   * prominent outside an explicit advanced area" rule. */
  readonly identityDetailsCollapsed?: boolean;
}

const REGENERATE_CONFIRM_MESSAGE =
  'Regenerate your local identity? This creates a brand-new cryptographic identity. ' +
  'Servers you have connected to before will see this as a new, unrecognized identity, and you ' +
  'may lose any permissions associated with the old one. This cannot be undone.';

/**
 * Settings/profile identity section (T7 Section 40): nickname (editable), Identity ID (display +
 * Copy), Regenerate Identity (destructive, confirmation-gated). Deliberately no
 * account/login/logout/password/email UI — there is no central account.
 */
export function IdentityPanel({
  nickname,
  identity,
  onNicknameChange,
  onRegenerate,
  identityDetailsCollapsed = false,
}: IdentityPanelProps): ReactElement {
  const [nicknameInput, setNicknameInput] = useState(nickname);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    setNicknameInput(nickname);
  }, [nickname]);

  const handleSaveNickname = (): void => {
    setSaving(true);
    setSaveError(undefined);
    onNicknameChange(nicknameInput)
      .then((ok) => {
        if (!ok) setSaveError('Nickname must be 1-32 characters with no control characters.');
      })
      .catch(() => {
        setSaveError('Failed to save nickname.');
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const handleCopyId = (): void => {
    navigator.clipboard
      .writeText(identity.identityId)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => {
        // Clipboard access denied — non-critical, the id is still visible as plain text.
      });
  };

  const handleRegenerate = (): void => {
    if (!window.confirm(REGENERATE_CONFIRM_MESSAGE)) return;
    setRegenerating(true);
    onRegenerate()
      .catch(() => {
        // Best-effort: the identity panel simply keeps showing the previous (still valid) id.
      })
      .finally(() => {
        setRegenerating(false);
      });
  };

  return (
    <div className={styles.container}>
      {/* A plain `<div>`, not `<label>`, wraps each field — the row contains *two* interactive
          elements (an input/display plus a button), and nesting a `<button>` inside a real
          `<label>` risks confusing label-click-forwarding behavior; the input still gets a real
          accessible name via `aria-label` below. */}
      <div className={styles.field}>
        <span className={styles.fieldLabel} id="identity-nickname-label">
          Nickname
        </span>
        <div className={styles.row}>
          <input
            className={styles.input}
            aria-labelledby="identity-nickname-label"
            value={nicknameInput}
            onChange={(event) => {
              setNicknameInput(event.target.value);
            }}
            maxLength={32}
            disabled={saving}
          />
          <Button
            variant="secondary"
            onClick={handleSaveNickname}
            disabled={saving || nicknameInput === nickname}
          >
            Save
          </Button>
        </div>
        {saveError && (
          <p className={styles.error} role="alert">
            {saveError}
          </p>
        )}
      </div>

      {identityDetailsCollapsed && (
        <button
          type="button"
          className={styles.advancedToggle}
          aria-expanded={detailsOpen}
          onClick={() => {
            setDetailsOpen((prev) => !prev);
          }}
        >
          {detailsOpen ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          Advanced (cryptographic identity)
        </button>
      )}

      {(!identityDetailsCollapsed || detailsOpen) && (
        <>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Identity ID</span>
            <div className={styles.row}>
              <code className={styles.identityId}>{identity.identityId}</code>
              <Button variant="ghost" onClick={handleCopyId}>
                <Copy size={14} aria-hidden="true" />
                {copied ? 'Copied' : 'Copy ID'}
              </Button>
            </div>
          </div>

          {/* T13.1.1 — visually separated, danger-tinted subsection: further from the routine
              controls above, using `ui/Button`'s `danger` variant. The underlying `window.confirm`
              warning is unchanged/unweakened — see `REGENERATE_CONFIRM_MESSAGE` above. */}
          <div className={styles.dangerZone}>
            <p className={styles.dangerZoneTitle}>Danger zone</p>
            <p className={styles.dangerZoneHint}>
              Creates a brand-new cryptographic identity. Servers you have connected to before will
              see this as unrecognized, and you may lose any permissions tied to the old one. This
              cannot be undone.
            </p>
            <Button variant="danger" onClick={handleRegenerate} disabled={regenerating}>
              {regenerating ? 'Regenerating…' : 'Regenerate Identity'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
