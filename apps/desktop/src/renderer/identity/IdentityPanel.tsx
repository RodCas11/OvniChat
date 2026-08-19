import { useEffect, useState, type ReactElement } from 'react';

import type { DesktopIdentity } from '../../shared/ipc-contract.js';

interface IdentityPanelProps {
  readonly nickname: string;
  readonly identity: DesktopIdentity;
  readonly onNicknameChange: (nickname: string) => Promise<boolean>;
  readonly onRegenerate: () => Promise<void>;
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
}: IdentityPanelProps): ReactElement {
  const [nicknameInput, setNicknameInput] = useState(nickname);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

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
    <section>
      <h2>Identity</h2>
      <p>
        <label>
          Nickname{' '}
          <input
            value={nicknameInput}
            onChange={(event) => {
              setNicknameInput(event.target.value);
            }}
            maxLength={32}
            disabled={saving}
          />
        </label>{' '}
        <button
          type="button"
          onClick={handleSaveNickname}
          disabled={saving || nicknameInput === nickname}
        >
          Save
        </button>
        {saveError && <span role="alert"> {saveError}</span>}
      </p>
      <p>
        Identity ID: <code>{identity.identityId}</code>{' '}
        <button type="button" onClick={handleCopyId}>
          {copied ? 'Copied' : 'Copy ID'}
        </button>
      </p>
      <p>
        <button type="button" onClick={handleRegenerate} disabled={regenerating}>
          {regenerating ? 'Regenerating…' : 'Regenerate Identity'}
        </button>
      </p>
    </section>
  );
}
