/**
 * Narrow dependency `RealtimeClient` uses to answer a `server:identity-challenge` — deliberately
 * not "give me the private key" or "sign these bytes": every method here is IPC-shaped
 * (structured, bounded, promise-based) so `RealtimeClient` never sees or touches key material, and
 * so it stays unit-testable with a fake signer with no Electron/IPC involved at all. See
 * `docs/architecture/CLIENT_IDENTITY.md`.
 */
export interface IdentitySigner {
  /** The local identity's public half, loading/creating it on first use. */
  getPublicIdentity(): Promise<{ readonly identityId: string; readonly publicKey: string }>;
  /** The current persisted nickname preference (empty string before one is ever chosen). */
  getNickname(): Promise<string>;
  /** Signs one identity-challenge on the local identity's behalf; the signer (Main, in practice)
   * reconstructs the canonical payload itself from these fields — this call can never be used to
   * sign arbitrary bytes. */
  signIdentityChallenge(params: {
    readonly protocolVersion: number;
    readonly connectionId: string;
    readonly nonce: string;
    readonly expiresAt: number;
    readonly nickname: string;
  }): Promise<string>;
}

/** The production `IdentitySigner`, backed by the `desktopApp` preload bridge. */
export class IpcIdentitySigner implements IdentitySigner {
  getPublicIdentity(): Promise<{ readonly identityId: string; readonly publicKey: string }> {
    return window.desktopApp.getIdentity();
  }

  getNickname(): Promise<string> {
    return window.desktopApp.getNickname();
  }

  signIdentityChallenge(params: {
    readonly protocolVersion: number;
    readonly connectionId: string;
    readonly nonce: string;
    readonly expiresAt: number;
    readonly nickname: string;
  }): Promise<string> {
    return window.desktopApp.signIdentityChallenge(params);
  }
}
