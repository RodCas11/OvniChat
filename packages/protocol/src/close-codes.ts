/**
 * WebSocket close codes this server uses. `1000`/`1001`/`1009` are standard codes defined by
 * RFC 6455; the rest are application-specific codes in RFC 6455's private-use range (4000-4999),
 * one per {@link ErrorCode} that results in a closed connection.
 */
export const CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  MESSAGE_TOO_LARGE: 1009,
  INVALID_MESSAGE: 4400,
  UNSUPPORTED_PROTOCOL: 4401,
  HANDSHAKE_REQUIRED: 4402,
  HANDSHAKE_TIMEOUT: 4403,
  UNEXPECTED_MESSAGE: 4404,
  RATE_LIMITED: 4429,
  IDENTITY_INVALID_PUBLIC_KEY: 4410,
  IDENTITY_INVALID_SIGNATURE: 4411,
  IDENTITY_CHALLENGE_EXPIRED: 4412,
  IDENTITY_PROTOCOL_ERROR: 4413,
  INTERNAL_ERROR: 4500,
  SERVER_AT_CAPACITY: 4503,
} as const;

export type CloseCodeName = keyof typeof CLOSE_CODES;
