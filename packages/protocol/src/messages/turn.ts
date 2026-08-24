import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';

/**
 * T14 — server -> client only, pushed once as part of the `handleIdentityProof` success actions
 * (alongside `server:hello`/`server:authorization-state`/`voice:catalog`/`server:presence-snapshot`)
 * whenever the Dedicated Server has TURN configured (`TurnConfig` — see
 * `services/dedicated-server/src/config.ts`). Absent entirely (no message sent at all, never sent
 * with an empty `iceServers` array) when the operator has not configured TURN — a self-hosted
 * deployment with no TURN relay (STUN/P2P only) is a fully supported configuration.
 *
 * `iceServers` mirrors the shape `RTCPeerConnection`'s own `iceServers` constructor option expects
 * (`urls`/`username`/`credential`), so a client can pass this straight through with no reshaping.
 * `username`/`credential` are short-lived Coturn `use-auth-secret` REST credentials
 * (`mintTurnCredentials`) — this server never sends a durable/reusable TURN secret over the wire.
 * `expiresAt` is an ISO-8601 timestamp so a client can proactively avoid relying on an
 * already-expired credential (e.g. re-requesting fresh ones on a later reconnect handshake, which
 * mints an entirely new set the same way as this one — there is no "refresh" message, since a fresh
 * identity-proof handshake already happens on every reconnect per ADR 0016).
 *
 * Additive to the existing `server:*` discriminated union — no `CURRENT_PROTOCOL_VERSION` bump (see
 * `version.ts`'s own doc comment on the established "new message type" precedent, e.g. T9/T13.3).
 */
export const serverTurnCredentialsMessageSchema = z
  .object({
    type: z.literal('server:turn-credentials'),
    id: messageIdSchema,
    iceServers: z
      .array(
        z
          .object({
            urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
            username: z.string().min(1).optional(),
            credential: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    expiresAt: z.string().min(1),
  })
  .strict();

export type ServerTurnCredentialsMessage = z.infer<typeof serverTurnCredentialsMessageSchema>;
