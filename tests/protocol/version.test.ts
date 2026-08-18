import { describe, expect, it } from 'vitest';

import {
  CURRENT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
} from '../../packages/protocol/src/version.js';

describe('protocol version', () => {
  it('the current version is itself supported', () => {
    expect(isSupportedProtocolVersion(CURRENT_PROTOCOL_VERSION)).toBe(true);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(CURRENT_PROTOCOL_VERSION);
  });

  it('rejects an unsupported future version', () => {
    expect(isSupportedProtocolVersion(CURRENT_PROTOCOL_VERSION + 1)).toBe(false);
  });

  it('rejects version 0 and negative numbers', () => {
    expect(isSupportedProtocolVersion(0)).toBe(false);
    expect(isSupportedProtocolVersion(-1)).toBe(false);
  });
});
