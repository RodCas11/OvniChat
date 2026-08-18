import { describe, expect, it } from 'vitest';

import { toRtcIceServers } from '../../packages/rtc-core/src/ice-servers.js';
import type { RtcTransportConfig } from '../../packages/rtc-core/src/types.js';

describe('toRtcIceServers', () => {
  it('passes a single URL string through unchanged', () => {
    const config: RtcTransportConfig = { iceServers: [{ urls: 'stun:stun.example.com:3478' }] };

    expect(toRtcIceServers(config)).toEqual([{ urls: 'stun:stun.example.com:3478' }]);
  });

  it('copies a readonly urls array into a mutable array', () => {
    const config: RtcTransportConfig = {
      iceServers: [{ urls: ['turn:turn1.example.com:3478', 'turn:turn2.example.com:3478'] }],
    };

    const result = toRtcIceServers(config);

    expect(result).toEqual([
      { urls: ['turn:turn1.example.com:3478', 'turn:turn2.example.com:3478'] },
    ]);
    expect(Array.isArray(result[0]?.urls)).toBe(true);
  });

  it('includes username/credential only when present, never as an explicit undefined', () => {
    const config: RtcTransportConfig = {
      iceServers: [
        { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'secret' },
        { urls: 'stun:stun.example.com:3478' },
      ],
    };

    const result = toRtcIceServers(config);

    expect(result[0]).toEqual({
      urls: 'turn:turn.example.com:3478',
      username: 'user',
      credential: 'secret',
    });
    expect(result[1]).toEqual({ urls: 'stun:stun.example.com:3478' });
    expect('username' in (result[1] as object)).toBe(false);
    expect('credential' in (result[1] as object)).toBe(false);
  });

  it('maps every configured server, preserving order', () => {
    const config: RtcTransportConfig = {
      iceServers: [{ urls: 'stun:a.example.com' }, { urls: 'stun:b.example.com' }],
    };

    expect(toRtcIceServers(config).map((server) => server.urls)).toEqual([
      'stun:a.example.com',
      'stun:b.example.com',
    ]);
  });
});
