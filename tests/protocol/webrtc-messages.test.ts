import { describe, expect, it } from 'vitest';

import {
  SDP_MAX_LENGTH,
  clientWebrtcAnswerMessageSchema,
  clientWebrtcIceCandidateMessageSchema,
  clientWebrtcOfferMessageSchema,
  serverWebrtcIceCandidateMessageSchema,
  serverWebrtcOfferMessageSchema,
} from '../../packages/protocol/src/messages/webrtc.js';

const validCandidate = {
  candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 54321 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
  usernameFragment: 'abcd',
};

describe('clientWebrtcOfferMessageSchema', () => {
  it('accepts a valid offer', () => {
    expect(
      clientWebrtcOfferMessageSchema.safeParse({
        type: 'webrtc:offer',
        id: 'o1',
        targetParticipantId: 'p2',
        sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n',
      }).success,
    ).toBe(true);
  });

  it('rejects an oversized SDP', () => {
    expect(
      clientWebrtcOfferMessageSchema.safeParse({
        type: 'webrtc:offer',
        id: 'o1',
        targetParticipantId: 'p2',
        sdp: 'x'.repeat(SDP_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an empty SDP', () => {
    expect(
      clientWebrtcOfferMessageSchema.safeParse({
        type: 'webrtc:offer',
        id: 'o1',
        targetParticipantId: 'p2',
        sdp: '',
      }).success,
    ).toBe(false);
  });

  it('does not accept a client-supplied source identity (unexpected field)', () => {
    expect(
      clientWebrtcOfferMessageSchema.safeParse({
        type: 'webrtc:offer',
        id: 'o1',
        targetParticipantId: 'p2',
        sdp: 'v=0',
        sourceParticipantId: 'spoofed',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing target', () => {
    expect(
      clientWebrtcOfferMessageSchema.safeParse({ type: 'webrtc:offer', id: 'o1', sdp: 'v=0' })
        .success,
    ).toBe(false);
  });
});

describe('clientWebrtcAnswerMessageSchema', () => {
  it('accepts a valid answer', () => {
    expect(
      clientWebrtcAnswerMessageSchema.safeParse({
        type: 'webrtc:answer',
        id: 'a1',
        targetParticipantId: 'p1',
        sdp: 'v=0',
      }).success,
    ).toBe(true);
  });
});

describe('clientWebrtcIceCandidateMessageSchema', () => {
  it('accepts a valid ICE candidate', () => {
    expect(
      clientWebrtcIceCandidateMessageSchema.safeParse({
        type: 'webrtc:ice-candidate',
        id: 'i1',
        targetParticipantId: 'p2',
        candidate: validCandidate,
      }).success,
    ).toBe(true);
  });

  it('accepts null as an explicit end-of-candidates signal', () => {
    expect(
      clientWebrtcIceCandidateMessageSchema.safeParse({
        type: 'webrtc:ice-candidate',
        id: 'i1',
        targetParticipantId: 'p2',
        candidate: null,
      }).success,
    ).toBe(true);
  });

  it('accepts an empty candidate string as an end-of-candidates signal', () => {
    expect(
      clientWebrtcIceCandidateMessageSchema.safeParse({
        type: 'webrtc:ice-candidate',
        id: 'i1',
        targetParticipantId: 'p2',
        candidate: { candidate: '' },
      }).success,
    ).toBe(true);
  });

  it('rejects an oversized candidate string', () => {
    expect(
      clientWebrtcIceCandidateMessageSchema.safeParse({
        type: 'webrtc:ice-candidate',
        id: 'i1',
        targetParticipantId: 'p2',
        candidate: { candidate: 'x'.repeat(2000) },
      }).success,
    ).toBe(false);
  });

  it('rejects unexpected fields inside the candidate object', () => {
    expect(
      clientWebrtcIceCandidateMessageSchema.safeParse({
        type: 'webrtc:ice-candidate',
        id: 'i1',
        targetParticipantId: 'p2',
        candidate: { ...validCandidate, extra: true },
      }).success,
    ).toBe(false);
  });
});

describe('server webrtc messages carry sourceParticipantId, not targetParticipantId', () => {
  it('accepts a forwarded offer with a source identity', () => {
    expect(
      serverWebrtcOfferMessageSchema.safeParse({
        type: 'webrtc:offer',
        id: 'o1',
        sourceParticipantId: 'p1',
        sdp: 'v=0',
      }).success,
    ).toBe(true);
  });

  it('rejects a forwarded offer that still has a targetParticipantId (wrong shape for this direction)', () => {
    expect(
      serverWebrtcOfferMessageSchema.safeParse({
        type: 'webrtc:offer',
        id: 'o1',
        targetParticipantId: 'p2',
        sdp: 'v=0',
      }).success,
    ).toBe(false);
  });

  it('accepts a forwarded ICE candidate with an end-of-candidates null', () => {
    expect(
      serverWebrtcIceCandidateMessageSchema.safeParse({
        type: 'webrtc:ice-candidate',
        id: 'i1',
        sourceParticipantId: 'p1',
        candidate: null,
      }).success,
    ).toBe(true);
  });
});
