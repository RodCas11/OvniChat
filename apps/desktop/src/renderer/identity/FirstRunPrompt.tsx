import { useState, type FormEvent, type ReactElement } from 'react';

interface FirstRunPromptProps {
  readonly onContinue: (nickname: string) => Promise<boolean>;
}

/**
 * The entire first-run flow (T7 Section 41-42): choose a nickname, Continue, done. No account,
 * no email, no password — deliberately not a multi-page wizard, since there is nothing else to
 * collect. The local identity itself is generated lazily behind `onContinue` (via
 * `getIdentity()`'s create-on-first-use behavior), not here.
 */
export function FirstRunPrompt({ onContinue }: FirstRunPromptProps): ReactElement {
  const [nickname, setNickname] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);

    void onContinue(nickname)
      .then((ok) => {
        if (!ok) {
          setError('Nickname must be 1-32 characters with no control characters.');
          setSubmitting(false);
        }
        // On success the parent re-renders past this screen; no local state update needed.
      })
      .catch(() => {
        setError('Could not set up your local identity. Please try again.');
        setSubmitting(false);
      });
  };

  return (
    <main>
      <h1>Welcome to Disco Voador</h1>
      <p>
        Choose a nickname to get started. There is no account, no email, and no password — Disco
        Voador generates a local cryptographic identity for you that stays on this device.
      </p>
      <form onSubmit={handleSubmit}>
        <label>
          Nickname{' '}
          <input
            value={nickname}
            onChange={(event) => {
              setNickname(event.target.value);
            }}
            maxLength={32}
            required
            disabled={submitting}
            autoFocus
          />
        </label>{' '}
        <button type="submit" disabled={submitting || nickname.trim().length === 0}>
          {submitting ? 'Generating local identity…' : 'Continue'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
