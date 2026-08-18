import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HeartbeatMonitor } from '../../services/realtime/src/heartbeat.js';

describe('HeartbeatMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a ping on every interval tick', () => {
    const sendPing = vi.fn();
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor(1000, 500, { sendPing, onTimeout });

    monitor.start();
    expect(sendPing).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(sendPing).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(sendPing).toHaveBeenCalledTimes(2);
  });

  it('does not time out when a pong acknowledges before the grace period elapses', () => {
    const sendPing = vi.fn();
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor(1000, 500, { sendPing, onTimeout });

    monitor.start();
    vi.advanceTimersByTime(1000); // ping sent
    monitor.acknowledge(); // pong received
    vi.advanceTimersByTime(500); // the timeout window that would have fired

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('declares the connection dead if no pong arrives within the grace period', () => {
    const sendPing = vi.fn();
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor(1000, 500, { sendPing, onTimeout });

    monitor.start();
    vi.advanceTimersByTime(1000); // ping sent, no acknowledge
    vi.advanceTimersByTime(500); // grace period elapses

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('stops sending pings and cancels pending timeouts after stop()', () => {
    const sendPing = vi.fn();
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor(1000, 500, { sendPing, onTimeout });

    monitor.start();
    vi.advanceTimersByTime(1000); // ping sent
    monitor.stop();
    vi.advanceTimersByTime(5000);

    expect(sendPing).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('treats each interval tick as an independent ping/pong pair', () => {
    const sendPing = vi.fn();
    const onTimeout = vi.fn();
    const monitor = new HeartbeatMonitor(1000, 500, { sendPing, onTimeout });

    monitor.start();
    vi.advanceTimersByTime(1000); // ping #1
    monitor.acknowledge(); // pong #1
    vi.advanceTimersByTime(1000); // ping #2, no acknowledge this time
    vi.advanceTimersByTime(500); // grace period for ping #2 elapses

    expect(sendPing).toHaveBeenCalledTimes(2);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
