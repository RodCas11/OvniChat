import { useCallback, useEffect, useState } from 'react';

import type { DesktopIdentity } from '../../shared/ipc-contract.js';

export type IdentityState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly nickname: string; readonly identity: DesktopIdentity }
  | { readonly status: 'error'; readonly message: string };

export interface UseIdentityResult {
  readonly state: IdentityState;
  /** `true` only once a nickname has ever been chosen — an empty nickname is the first-run
   * signal, never a valid ongoing state (T7 Section 41). */
  readonly setNickname: (nickname: string) => Promise<boolean>;
  /** Destructive; callers must gate this behind an explicit user confirmation themselves — this
   * hook does not prompt on its own. */
  readonly regenerate: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown local identity error';
}

/**
 * Loads the client-local nickname preference and public identity once on mount. Both come from
 * Main over IPC (see `main/identity/`) — this hook never sees, requests, or could request the
 * private key itself.
 */
export function useIdentity(): UseIdentityResult {
  const [state, setState] = useState<IdentityState>({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    Promise.all([window.desktopApp.getNickname(), window.desktopApp.getIdentity()])
      .then(([nickname, identity]) => {
        setState({ status: 'ready', nickname, identity });
        // Public data only (never the private key) — a single informational line per load, used
        // by the T7 identity-persistence/authentication E2E scripts to observe this instance's
        // local identityId without scraping the DOM. See
        // `apps/desktop/scripts/e2e-identity-persistence.mjs`.
        console.info(`disco-voador:local-identity-ready:${identity.identityId}`);
      })
      .catch((error: unknown) => {
        setState({ status: 'error', message: errorMessage(error) });
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setNickname = useCallback(async (nickname: string): Promise<boolean> => {
    const ok = await window.desktopApp.setNickname(nickname);
    if (ok) {
      setState((prev) => (prev.status === 'ready' ? { ...prev, nickname: nickname.trim() } : prev));
    }
    return ok;
  }, []);

  const regenerate = useCallback(async (): Promise<void> => {
    await window.desktopApp.regenerateIdentity();
    // Reload rather than a targeted state patch: this must also work from the `'error'` state
    // (the corrupted-identity recovery path — see `App.tsx`'s error screen), not only from
    // `'ready'`, and a full reload naturally picks up the nickname unchanged alongside the new
    // identity with no separate code path for either starting state.
    load();
  }, [load]);

  return { state, setNickname, regenerate };
}
