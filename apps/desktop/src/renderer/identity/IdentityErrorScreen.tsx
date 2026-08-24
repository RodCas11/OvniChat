import { useState, type ReactElement } from 'react';

interface IdentityErrorScreenProps {
  readonly message: string;
  readonly onRegenerate: () => Promise<void>;
}

const START_OVER_CONFIRM_MESSAGE =
  'Your local identity could not be loaded and may be corrupted. Starting over creates a ' +
  'brand-new cryptographic identity. Servers you have connected to before will see this as a ' +
  'new, unrecognized identity, and you may lose any permissions associated with the old one. ' +
  'This cannot be undone.';

/**
 * Shown when `identity-service.ts` fails to load a persisted identity (corrupted file, secure
 * storage unavailable, etc. — see `docs/architecture/CLIENT_IDENTITY.md`'s "Corruption handling").
 * Never regenerates automatically; the one way forward is the same explicit, confirmation-gated
 * action `IdentityPanel`'s Regenerate button uses, so a user genuinely stuck (e.g. a corrupted
 * identity file) has a path back into the app without needing to find and delete the file by hand
 * outside it — QA-flagged gap, closed here.
 */
export function IdentityErrorScreen({
  message,
  onRegenerate,
}: IdentityErrorScreenProps): ReactElement {
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | undefined>(undefined);

  const handleStartOver = (): void => {
    if (!window.confirm(START_OVER_CONFIRM_MESSAGE)) return;
    setRegenerating(true);
    setRegenerateError(undefined);
    onRegenerate().catch(() => {
      setRegenerateError('Failed to create a new identity. Please try again.');
      setRegenerating(false);
    });
  };

  return (
    <main>
      <h1>Chantivo</h1>
      <p role="alert">Local identity error: {message}</p>
      <p>
        <button type="button" onClick={handleStartOver} disabled={regenerating}>
          {regenerating ? 'Creating a new identity…' : 'Start Over With a New Identity'}
        </button>
      </p>
      {regenerateError && <p role="alert">{regenerateError}</p>}
    </main>
  );
}
