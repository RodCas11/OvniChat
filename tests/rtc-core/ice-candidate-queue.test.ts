import { describe, expect, it } from 'vitest';

import { IceCandidateQueue } from '../../packages/rtc-core/src/ice-candidate-queue.js';

describe('IceCandidateQueue', () => {
  it('reports the remote description as not set until markRemoteDescriptionSet is called', () => {
    const queue = new IceCandidateQueue();

    expect(queue.isRemoteDescriptionSet()).toBe(false);
    queue.markRemoteDescriptionSet();
    expect(queue.isRemoteDescriptionSet()).toBe(true);
  });

  it('drains queued candidates in the order they were enqueued', () => {
    const queue = new IceCandidateQueue();
    const first: RTCIceCandidateInit = { candidate: 'candidate:1', sdpMLineIndex: 0 };
    const second: RTCIceCandidateInit = { candidate: 'candidate:2', sdpMLineIndex: 0 };

    queue.enqueue(first);
    queue.enqueue(second);

    expect(queue.drain()).toEqual([first, second]);
  });

  it('treats a queued null as the end-of-candidates signal, not an absent value', () => {
    const queue = new IceCandidateQueue();
    queue.enqueue({ candidate: 'candidate:1', sdpMLineIndex: 0 });
    queue.enqueue(null);

    expect(queue.drain()).toEqual([{ candidate: 'candidate:1', sdpMLineIndex: 0 }, null]);
  });

  it('clears the queue after draining — a second drain is empty', () => {
    const queue = new IceCandidateQueue();
    queue.enqueue({ candidate: 'candidate:1', sdpMLineIndex: 0 });

    queue.drain();

    expect(queue.drain()).toEqual([]);
  });

  it('marking the remote description set does not itself drain the queue', () => {
    const queue = new IceCandidateQueue();
    queue.enqueue({ candidate: 'candidate:1', sdpMLineIndex: 0 });

    queue.markRemoteDescriptionSet();

    expect(queue.drain()).toHaveLength(1);
  });
});
