import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import { errorCodeSchema } from '../errors.js';
import {
  identityConnectionIdSchema,
  identityExpiresAtSchema,
  identityIdSchema,
  identityNonceSchema,
} from '../identity.js';
import { serverMediaTrackSourceMessageSchema } from './media.js';
import {
  serverWebrtcAnswerMessageSchema,
  serverWebrtcIceCandidateMessageSchema,
  serverWebrtcOfferMessageSchema,
} from './webrtc.js';
import {
  serverVoiceCatalogMessageSchema,
  serverVoiceJoinedMessageSchema,
  serverVoiceLeftMessageSchema,
  serverVoiceParticipantJoinedMessageSchema,
  serverVoiceParticipantLeftMessageSchema,
} from './voice.js';

/**
 * `server:hello` answers a successful handshake — now only reachable after the T7
 * identity-challenge/proof exchange verifies. It carries only what proves negotiation succeeded
 * and lets the client behave correctly (its own connection identity, its server-authenticated
 * `identityId`, the server's heartbeat cadence) — no speculative product/presence state.
 * `identityId` is always the server's own derivation from the verified public key (see
 * `@disco-voador/identity`'s `deriveIdentityId`), never a value the client supplied.
 */
export const serverHelloMessageSchema = z
  .object({
    type: z.literal('server:hello'),
    id: messageIdSchema,
    protocolVersion: z.number().int().positive(),
    connectionId: z.string().min(1),
    identityId: identityIdSchema,
    serverTime: z.string().min(1),
    heartbeat: z
      .object({
        intervalMs: z.number().int().positive(),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type ServerHelloMessage = z.infer<typeof serverHelloMessageSchema>;

/**
 * Issued once per connection, immediately after a structurally valid `client:hello`, before
 * `server:hello`. `nonce` is fresh cryptographically-secure randomness (never `Date.now()`,
 * `Math.random()`, or a counter); `expiresAt` is an epoch-millisecond deadline after which a
 * `client:identity-proof` answering this exact challenge is rejected with
 * `IDENTITY_CHALLENGE_EXPIRED`. `connectionId` is echoed so the client's canonical-payload
 * construction (`buildIdentityAuthPayload`) never has to guess or separately track it.
 */
export const serverIdentityChallengeMessageSchema = z
  .object({
    type: z.literal('server:identity-challenge'),
    id: messageIdSchema,
    connectionId: identityConnectionIdSchema,
    nonce: identityNonceSchema,
    expiresAt: identityExpiresAtSchema,
  })
  .strict();

export type ServerIdentityChallengeMessage = z.infer<typeof serverIdentityChallengeMessageSchema>;

/** Answers `client:ping`; `id` echoes the ping's `id`. */
export const serverPongMessageSchema = z
  .object({
    type: z.literal('server:pong'),
    id: messageIdSchema,
  })
  .strict();

export type ServerPongMessage = z.infer<typeof serverPongMessageSchema>;

export const serverErrorMessageSchema = z
  .object({
    type: z.literal('server:error'),
    id: messageIdSchema,
    code: errorCodeSchema,
    message: z.string().min(1).max(256),
    replyTo: messageIdSchema.optional(),
  })
  .strict();

export type ServerErrorMessage = z.infer<typeof serverErrorMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  serverHelloMessageSchema,
  serverIdentityChallengeMessageSchema,
  serverPongMessageSchema,
  serverErrorMessageSchema,
  serverVoiceCatalogMessageSchema,
  serverVoiceJoinedMessageSchema,
  serverVoiceLeftMessageSchema,
  serverVoiceParticipantJoinedMessageSchema,
  serverVoiceParticipantLeftMessageSchema,
  serverWebrtcOfferMessageSchema,
  serverWebrtcAnswerMessageSchema,
  serverWebrtcIceCandidateMessageSchema,
  serverMediaTrackSourceMessageSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
