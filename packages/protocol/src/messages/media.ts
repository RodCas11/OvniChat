import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import { participantIdSchema } from '../identifiers.js';

/**
 * T5 introduced this for video: once both camera and screen-video exist, `track.kind === 'video'`
 * no longer identifies what a video track actually shows. T6 extends the same discriminator to
 * audio for the identical reason: once both microphone and screen-audio exist, `track.kind ===
 * 'audio'` no longer identifies what an audio track carries either — inferring "the only audio
 * source is the microphone" (true through T5) or "first/second audio track" would be exactly the
 * absence-/order-based inference this mechanism exists to avoid. `'microphone'` is therefore an
 * explicit member here, announced through the same `media:track-source` message as every other
 * source, not a special unannounced default.
 */
export const trackSourceSchema = z.enum(['microphone', 'camera', 'screen-video', 'screen-audio']);
export type TrackSource = z.infer<typeof trackSourceSchema>;

/**
 * The SDP media identification (`a=mid:`) a track's transceiver negotiated *on one specific peer
 * connection* — not a global track identifier. Real `mid` values are short (single- or low-double-
 * digit strings in practice, e.g. "0", "1", "audio1"); this bound is generous headroom, not an
 * expected length. This server never interprets the string, only bounds it.
 *
 * `MediaStreamTrack.id` was the first design tried here and was rejected after live two-instance
 * testing found it does **not** reliably survive unchanged across this application's WebRTC
 * connections (a real, reproducible Electron/Chromium finding, not a spec violation on this
 * package's part — see `docs/architecture/WEBRTC_SCREEN_SHARE.md`'s "Media source identity"
 * section for the recorded evidence). `mid` does survive, which is why this message is *targeted*
 * (`targetParticipantId`/`sourceParticipantId`, mirroring `webrtc:*`) rather than a channel-wide
 * broadcast: `mid` is assigned per peer connection, so the same local track can carry a different
 * `mid` on different peer connections in a mesh — there is no single value that would be correct
 * to broadcast to everyone at once.
 */
const MID_MAX_LENGTH = 64;
export const midSchema = z.string().min(1).max(MID_MAX_LENGTH);

/**
 * Client -> server: "on the connection between us, the track at this `mid` is a `source`." The
 * server derives and substitutes `sourceParticipantId`, exactly like `webrtc:*` forwarding — a
 * client never states its own participant identity, so there is nothing here to spoof.
 */
export const clientMediaTrackSourceMessageSchema = z
  .object({
    type: z.literal('media:track-source'),
    id: messageIdSchema,
    targetParticipantId: participantIdSchema,
    mid: midSchema,
    source: trackSourceSchema,
  })
  .strict();

export type ClientMediaTrackSourceMessage = z.infer<typeof clientMediaTrackSourceMessageSchema>;

export const serverMediaTrackSourceMessageSchema = z
  .object({
    type: z.literal('media:track-source'),
    id: messageIdSchema,
    sourceParticipantId: participantIdSchema,
    mid: midSchema,
    source: trackSourceSchema,
  })
  .strict();

export type ServerMediaTrackSourceMessage = z.infer<typeof serverMediaTrackSourceMessageSchema>;
