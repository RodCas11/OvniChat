import type { z } from 'zod';

import { type ClientMessage, clientMessageSchema } from './messages/client.js';
import { type ServerMessage, serverMessageSchema } from './messages/server.js';

export type ParseResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly issues: readonly string[] };

function formatIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/**
 * Parses and validates an already-JSON-decoded value as a {@link ClientMessage}. Never throws —
 * untrusted network input must always produce a result the caller can branch on, not an exception
 * to remember to catch.
 */
export function parseClientMessage(value: unknown): ParseResult<ClientMessage> {
  const result = clientMessageSchema.safeParse(value);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, issues: formatIssues(result.error) };
}

export function parseServerMessage(value: unknown): ParseResult<ServerMessage> {
  const result = serverMessageSchema.safeParse(value);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, issues: formatIssues(result.error) };
}
