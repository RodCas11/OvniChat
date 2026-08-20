import { CLOSE_CODES, type CloseCodeName } from '@disco-voador/protocol';

/**
 * Classifies a WebSocket close code as worth automatically retrying or not (T11 Section 41). The
 * server closes every fatal protocol/authorization failure with the specific numeric code matching
 * its `ErrorCode` (`packages/protocol/src/close-codes.ts`'s doc comment: "one per ErrorCode that
 * results in a closed connection") — so the raw close code alone is enough to classify the failure;
 * there is no need to also correlate a preceding `server:error` message.
 *
 * An *unknown* code (most commonly `1006` — "abnormal closure," which the platform assigns
 * automatically when the TCP connection drops without a WebSocket close handshake, e.g. a network
 * interruption or the server process being killed) is treated as retryable by default: every
 * concrete non-retryable case this app can actually produce is named explicitly below, so an unknown
 * code is far more likely to be an ordinary transport-level drop than a new fatal condition nobody
 * taught this function about yet.
 */
export type ReconnectDecision = 'retry' | 'no-retry';

const CLOSE_CODE_TO_NAME: ReadonlyMap<number, CloseCodeName> = new Map(
  (Object.entries(CLOSE_CODES) as [CloseCodeName, number][]).map(([name, code]) => [code, name]),
);

/**
 * Non-retryable: either a genuine client/protocol bug that a retry would only reproduce
 * identically (`INVALID_MESSAGE`, `UNSUPPORTED_PROTOCOL`, `HANDSHAKE_REQUIRED`,
 * `UNEXPECTED_MESSAGE`, `MESSAGE_TOO_LARGE`), a broken/unusable local identity that reconnecting
 * cannot fix on its own (`IDENTITY_INVALID_PUBLIC_KEY`, `IDENTITY_INVALID_SIGNATURE`,
 * `IDENTITY_PROTOCOL_ERROR` — deliberately *not* `IDENTITY_CHALLENGE_EXPIRED`, which is a timing
 * condition a fresh challenge on retry genuinely resolves), or an explicit authorization decision
 * that requires user action, not a silent retry loop (`INVITE_REQUIRED` — needs a token;
 * `BANNED`/`KICKED` — moderation actions the user must be shown, not retried around).
 */
const NON_RETRYABLE_CLOSE_CODE_NAMES: ReadonlySet<CloseCodeName> = new Set([
  'INVALID_MESSAGE',
  'UNSUPPORTED_PROTOCOL',
  'HANDSHAKE_REQUIRED',
  'UNEXPECTED_MESSAGE',
  'MESSAGE_TOO_LARGE',
  'IDENTITY_INVALID_PUBLIC_KEY',
  'IDENTITY_INVALID_SIGNATURE',
  'IDENTITY_PROTOCOL_ERROR',
  'INVITE_REQUIRED',
  'BANNED',
  'KICKED',
]);

export function classifyCloseCode(code: number): ReconnectDecision {
  const name = CLOSE_CODE_TO_NAME.get(code);
  if (name && NON_RETRYABLE_CLOSE_CODE_NAMES.has(name)) return 'no-retry';
  return 'retry';
}

/** A short, human-readable explanation for a non-retryable close — shown by the connection-error UI
 * instead of technical close-code text (T11 Section 60). Returns `undefined` for a retryable code
 * (the reconnect UI has its own "Connection lost, reconnecting…" copy for those) or an unrecognized
 * one. */
export function describeNonRetryableClose(code: number): string | undefined {
  const name = CLOSE_CODE_TO_NAME.get(code);
  switch (name) {
    case 'BANNED':
      return 'You are banned from this server.';
    case 'KICKED':
      return 'You were kicked from this server.';
    case 'INVITE_REQUIRED':
      return 'This server requires an invite or privilege key to join.';
    case 'UNSUPPORTED_PROTOCOL':
      return 'This client is not compatible with this server.';
    case 'IDENTITY_INVALID_PUBLIC_KEY':
    case 'IDENTITY_INVALID_SIGNATURE':
    case 'IDENTITY_PROTOCOL_ERROR':
      return 'Your local identity was rejected by the server.';
    case 'INVALID_MESSAGE':
    case 'HANDSHAKE_REQUIRED':
    case 'UNEXPECTED_MESSAGE':
    case 'MESSAGE_TOO_LARGE':
      return 'The connection was closed due to a protocol error.';
    default:
      return undefined;
  }
}
