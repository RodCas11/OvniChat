import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import { displayNameSchema } from '../identifiers.js';
import { identityPublicKeySchema, identitySignatureSchema } from '../identity.js';
import { clientMediaTrackSourceMessageSchema } from './media.js';
import {
  clientWebrtcAnswerMessageSchema,
  clientWebrtcIceCandidateMessageSchema,
  clientWebrtcOfferMessageSchema,
} from './webrtc.js';
import { clientVoiceJoinMessageSchema, clientVoiceLeaveMessageSchema } from './voice.js';

/**
 * `client:hello` opens the handshake. `protocolVersion` is intentionally `z.number().int()`
 * rather than a literal/enum of supported values: structurally *any* positive integer is a valid
 * hello, so an unrecognized version is a distinct, specifically-coded `UNSUPPORTED_PROTOCOL`
 * failure (checked by the caller against `SUPPORTED_PROTOCOL_VERSIONS`), not a generic
 * `INVALID_MESSAGE` schema failure. `client.name`/`client.version` are free-form, bounded,
 * untrusted diagnostic strings — never treated as an identity or trust signal.
 *
 * T7: `nickname` and `publicKey` claim the connection's local cryptographic identity and its
 * current display nickname; neither is trusted on its own — the server only treats the
 * connection as authenticated once `client:identity-proof` verifies the accompanying signature
 * (see `docs/architecture/CLIENT_IDENTITY.md`). `nickname` reuses `displayNameSchema` — the same
 * bounds already proven for `voice:join`'s `displayName` — deliberately: it is a separate,
 * connection-scoped preference, not a merge of the two concepts (a nickname change never affects
 * a channel session already in progress, and vice versa).
 */
export const clientHelloMessageSchema = z
  .object({
    type: z.literal('client:hello'),
    id: messageIdSchema,
    protocolVersion: z.number().int().positive(),
    client: z
      .object({
        name: z.string().min(1).max(64),
        version: z.string().min(1).max(32),
      })
      .strict(),
    nickname: displayNameSchema,
    publicKey: identityPublicKeySchema,
  })
  .strict();

export type ClientHelloMessage = z.infer<typeof clientHelloMessageSchema>;

/** `client:ping` is an explicit, client-initiated liveness/round-trip check. */
export const clientPingMessageSchema = z
  .object({
    type: z.literal('client:ping'),
    id: messageIdSchema,
  })
  .strict();

export type ClientPingMessage = z.infer<typeof clientPingMessageSchema>;

/**
 * Answers `server:identity-challenge`, proving possession of the private key matching the
 * `publicKey` presented at `client:hello`. `signature` is verified against
 * `buildIdentityAuthPayload` (see `identity.ts`), reconstructed server-side from the challenge it
 * issued plus the hello it already received — never trusted as a bare claim.
 */
export const clientIdentityProofMessageSchema = z
  .object({
    type: z.literal('client:identity-proof'),
    id: messageIdSchema,
    signature: identitySignatureSchema,
  })
  .strict();

export type ClientIdentityProofMessage = z.infer<typeof clientIdentityProofMessageSchema>;

export const clientMessageSchema = z.discriminatedUnion('type', [
  clientHelloMessageSchema,
  clientIdentityProofMessageSchema,
  clientPingMessageSchema,
  clientVoiceJoinMessageSchema,
  clientVoiceLeaveMessageSchema,
  clientWebrtcOfferMessageSchema,
  clientWebrtcAnswerMessageSchema,
  clientWebrtcIceCandidateMessageSchema,
  clientMediaTrackSourceMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
