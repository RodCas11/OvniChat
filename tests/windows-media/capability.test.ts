import { describe, expect, it } from 'vitest';

import {
  MINIMUM_PROCESS_LOOPBACK_BUILD,
  detectProcessAudioCapability,
} from '../../packages/windows-media/src/capability.js';

describe('detectProcessAudioCapability', () => {
  it('reports unsupported on a non-Windows platform regardless of release string', () => {
    const result = detectProcessAudioCapability('darwin', '23.6.0');
    expect(result).toEqual({ supported: false, reason: 'not-windows', detectedBuild: undefined });
  });

  it('reports unsupported on Windows below the minimum build', () => {
    const result = detectProcessAudioCapability('win32', '10.0.19045');
    expect(result).toEqual({ supported: false, reason: 'build-too-old', detectedBuild: 19045 });
  });

  it('reports supported exactly at the minimum build', () => {
    const result = detectProcessAudioCapability(
      'win32',
      `10.0.${String(MINIMUM_PROCESS_LOOPBACK_BUILD)}`,
    );
    expect(result).toEqual({ supported: true, detectedBuild: MINIMUM_PROCESS_LOOPBACK_BUILD });
  });

  it("reports supported on a build above the minimum, matching this task's real dev machine", () => {
    const result = detectProcessAudioCapability('win32', '10.0.26200');
    expect(result).toEqual({ supported: true, detectedBuild: 26200 });
  });

  it('reports unsupported (never assumed-supported) on an unparseable release string', () => {
    const result = detectProcessAudioCapability('win32', 'not-a-release-string');
    expect(result).toEqual({ supported: false, reason: 'build-too-old', detectedBuild: undefined });
  });

  it('defaults to the real platform/release when called with no arguments', () => {
    expect(() => detectProcessAudioCapability()).not.toThrow();
  });
});
