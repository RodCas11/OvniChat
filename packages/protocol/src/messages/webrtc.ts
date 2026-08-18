import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import { participantIdSchema } from '../identifiers.js';

/**
 * SDP and ICE are untrusted network payloads carried as bounded opaque strings — this server
 * never parses their semantic content (that's `RTCPeerConnection`'s job in the Renderer); it only
 * bounds their size so a hostile client cannot smuggle an oversized blob inside an otherwise-tiny
 * signaling message just because the global per-message limit is larger. A real audio-only SDP is
 * typically a few KB; 8 KiB leaves comfortable headroom.
 */
export const SDP_MAX_LENGTH = 8192;
export const sdpSchema = z.string().min(1).max(SDP_MAX_LENGTH);

const ICE_CANDIDATE_MAX_LENGTH = 1024;

/**
 * Mirrors `RTCIceCandidateInit`. `candidate` may be an empty string, and the whole payload may be
 * `null` (see the `*IceCandidateMessageSchema`s below) — both are legitimate end-of-candidates
 * signals that must not be rejected as malformed.
 */
export const iceCandidateSchema = z
  .object({
    candidate: z.string().max(ICE_CANDIDATE_MAX_LENGTH),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

export type IceCandidatePayload = z.infer<typeof iceCandidateSchema>;

/**
 * Client -> server: "please forward this SDP offer to `targetParticipantId`." The server derives
 * and substitutes the *sender's* identity server-side (`sourceParticipantId` on the forwarded
 * message) — a client never states its own source identity, so there is nothing here to spoof.
 */
export const clientWebrtcOfferMessageSchema = z
  .object({
    type: z.literal('webrtc:offer'),
    id: messageIdSchema,
    targetParticipantId: participantIdSchema,
    sdp: sdpSchema,
  })
  .strict();

export type ClientWebrtcOfferMessage = z.infer<typeof clientWebrtcOfferMessageSchema>;

export const clientWebrtcAnswerMessageSchema = z
  .object({
    type: z.literal('webrtc:answer'),
    id: messageIdSchema,
    targetParticipantId: participantIdSchema,
    sdp: sdpSchema,
  })
  .strict();

export type ClientWebrtcAnswerMessage = z.infer<typeof clientWebrtcAnswerMessageSchema>;

export const clientWebrtcIceCandidateMessageSchema = z
  .object({
    type: z.literal('webrtc:ice-candidate'),
    id: messageIdSchema,
    targetParticipantId: participantIdSchema,
    candidate: iceCandidateSchema.nullable(),
  })
  .strict();

export type ClientWebrtcIceCandidateMessage = z.infer<typeof clientWebrtcIceCandidateMessageSchema>;

export const clientWebrtcMessageSchema = z.discriminatedUnion('type', [
  clientWebrtcOfferMessageSchema,
  clientWebrtcAnswerMessageSchema,
  clientWebrtcIceCandidateMessageSchema,
]);

export type ClientWebrtcMessage = z.infer<typeof clientWebrtcMessageSchema>;

/**
 * Server -> client: the forwarded signal, attributed to its actual, server-verified
 * `sourceParticipantId`. Note `webrtc:offer`/`webrtc:answer`/`webrtc:ice-candidate` name the same
 * `type` string in both the client-bound and server-bound unions — deliberately: it is the same
 * kind of message, just carrying `targetParticipantId` (client -> server, "send this to...") in
 * one direction and `sourceParticipantId` (server -> client, "this came from...") in the other.
 * The two unions are parsed independently depending on direction, so this is unambiguous on the
 * wire.
 */
export const serverWebrtcOfferMessageSchema = z
  .object({
    type: z.literal('webrtc:offer'),
    id: messageIdSchema,
    sourceParticipantId: participantIdSchema,
    sdp: sdpSchema,
  })
  .strict();

export type ServerWebrtcOfferMessage = z.infer<typeof serverWebrtcOfferMessageSchema>;

export const serverWebrtcAnswerMessageSchema = z
  .object({
    type: z.literal('webrtc:answer'),
    id: messageIdSchema,
    sourceParticipantId: participantIdSchema,
    sdp: sdpSchema,
  })
  .strict();

export type ServerWebrtcAnswerMessage = z.infer<typeof serverWebrtcAnswerMessageSchema>;

export const serverWebrtcIceCandidateMessageSchema = z
  .object({
    type: z.literal('webrtc:ice-candidate'),
    id: messageIdSchema,
    sourceParticipantId: participantIdSchema,
    candidate: iceCandidateSchema.nullable(),
  })
  .strict();

export type ServerWebrtcIceCandidateMessage = z.infer<typeof serverWebrtcIceCandidateMessageSchema>;

export const serverWebrtcMessageSchema = z.discriminatedUnion('type', [
  serverWebrtcOfferMessageSchema,
  serverWebrtcAnswerMessageSchema,
  serverWebrtcIceCandidateMessageSchema,
]);

export type ServerWebrtcMessage = z.infer<typeof serverWebrtcMessageSchema>;
