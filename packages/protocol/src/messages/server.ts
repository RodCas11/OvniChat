import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import { errorCodeSchema } from '../errors.js';
import {
  identityConnectionIdSchema,
  identityExpiresAtSchema,
  identityIdSchema,
  identityNonceSchema,
} from '../identity.js';
import { avatarRefSchema } from '../profile.js';
import { serverCapabilitiesSchema, serverNameSchema } from '../server-metadata.js';
import { serverAuthorizationMessageSchema } from './authorization.js';
import { serverChannelMessageSchema } from './channels.js';
import { serverChatMessageSchema } from './chat.js';
import { serverMediaTrackSourceMessageSchema } from './media.js';
import { serverProfileMessageSchema } from './profile.js';
import { serverTurnCredentialsMessageSchema } from './turn.js';
import {
  serverWebrtcAnswerMessageSchema,
  serverWebrtcIceCandidateMessageSchema,
  serverWebrtcOfferMessageSchema,
} from './webrtc.js';
import {
  serverVoiceJoinedMessageSchema,
  serverVoiceLeftMessageSchema,
  serverVoiceParticipantJoinedMessageSchema,
  serverVoiceParticipantLeftMessageSchema,
} from './voice.js';

/**
 * `server:hello` answers a successful handshake — now only reachable after the T7
 * identity-challenge/proof exchange verifies. It carries only what proves negotiation succeeded
 * and lets the client behave correctly (its own connection identity, its server-authenticated
 * `identityId`, the server's heartbeat cadence, and — since T8 — minimal Dedicated Server display
 * metadata) — no speculative presence state, no admin/discovery surface.
 * `identityId` is always the server's own derivation from the verified public key (see
 * `@disco-voador/identity`'s `deriveIdentityId`), never a value the client supplied.
 * `serverName`/`serverCapabilities` are operator-facing display data (see
 * `docs/architecture/DEDICATED_SERVER.md`) — never treated as a trust or authorization signal.
 *
 * T13.3: `serverAvatarRef` is a new **optional** field — additive to this existing `.strict()`
 * schema, matching T9's own `client:hello.serverToken` optional-field precedent exactly (see
 * `version.ts`'s evolution policy) — present only when the server currently has an avatar set.
 */
export const serverHelloMessageSchema = z
  .object({
    type: z.literal('server:hello'),
    id: messageIdSchema,
    protocolVersion: z.number().int().positive(),
    connectionId: z.string().min(1),
    identityId: identityIdSchema,
    serverName: serverNameSchema,
    serverCapabilities: serverCapabilitiesSchema,
    serverTime: z.string().min(1),
    heartbeat: z
      .object({
        intervalMs: z.number().int().positive(),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
    serverAvatarRef: avatarRefSchema.optional(),
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
  serverVoiceJoinedMessageSchema,
  serverVoiceLeftMessageSchema,
  serverVoiceParticipantJoinedMessageSchema,
  serverVoiceParticipantLeftMessageSchema,
  serverWebrtcOfferMessageSchema,
  serverWebrtcAnswerMessageSchema,
  serverWebrtcIceCandidateMessageSchema,
  serverMediaTrackSourceMessageSchema,
  ...serverAuthorizationMessageSchema.options,
  ...serverChatMessageSchema.options,
  ...serverChannelMessageSchema.options,
  ...serverProfileMessageSchema.options,
  serverTurnCredentialsMessageSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
