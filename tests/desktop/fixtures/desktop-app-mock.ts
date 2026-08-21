// T13.1 QA fixture — installs a minimal, fully-typed stand-in for the Preload-exposed
// `window.desktopApp` bridge (`DesktopApi`) so a component test never needs a real Electron Main
// process/IPC round trip. Every method is a `vi.fn()` the test configures/asserts directly; nothing
// here approximates real network/IPC behavior (that boundary belongs to
// `tests/desktop/preload-bridge.test.ts`/`tests/desktop/ipc.test.ts`, unchanged by this task).
import { vi } from 'vitest';

import type {
  DesktopApi,
  DesktopClientSettings,
  DesktopIdentity,
} from '../../../apps/desktop/src/shared/ipc-contract.js';

export function createClientSettings(
  overrides: Partial<DesktopClientSettings> = {},
): DesktopClientSettings {
  return {
    audio: { inputDeviceId: null, outputDeviceId: null },
    video: { cameraDeviceId: null },
    screenShare: { qualityPreset: 'high' },
    voice: { startMuted: false, startDeafened: false },
    bookmarks: [],
    lastServerAddress: null,
    connectOnStartup: false,
    ...overrides,
  };
}

export function createIdentity(overrides: Partial<DesktopIdentity> = {}): DesktopIdentity {
  return { identityId: 'dv1_test-identity', publicKey: 'test-public-key', ...overrides };
}

/** Builds a complete `DesktopApi` mock with safe, inert defaults for every method — tests only ever
 * need to override the handful of calls the component under test actually makes. Returned as a
 * plain object (not yet installed on `window`) so a test can inspect/override individual methods
 * before calling {@link installDesktopAppMock}. */
export function createDesktopAppMock(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getVersionInfo: vi.fn().mockResolvedValue({ appVersion: '0.0.0', electronVersion: '43.0.0' }),
    getRealtimeConfig: vi.fn().mockResolvedValue({ url: 'ws://127.0.0.1:8090', iceServers: [] }),
    getE2EVoiceConfig: vi.fn().mockResolvedValue(undefined),
    getE2ESettingsPersistenceConfig: vi.fn().mockResolvedValue(undefined),
    listScreenShareSources: vi.fn().mockResolvedValue([]),
    selectScreenShareSource: vi.fn().mockResolvedValue(false),
    getProcessAudioCapability: vi.fn().mockResolvedValue({ supported: false, reason: 'test' }),
    listProcessAudioCandidates: vi.fn().mockResolvedValue({ supported: false, reason: 'test' }),
    cancelProcessAudioEnumeration: vi.fn().mockResolvedValue(undefined),
    startProcessAudioCapture: vi.fn().mockResolvedValue({ ok: false, reason: 'test' }),
    stopProcessAudioCapture: vi.fn().mockResolvedValue(undefined),
    onProcessAudioEnded: vi.fn().mockReturnValue(() => undefined),
    getIdentity: vi.fn().mockResolvedValue(createIdentity()),
    signIdentityChallenge: vi.fn().mockResolvedValue('signature'),
    regenerateIdentity: vi.fn().mockResolvedValue(createIdentity()),
    getNickname: vi.fn().mockResolvedValue(''),
    setNickname: vi.fn().mockResolvedValue(true),
    getClientSettings: vi.fn().mockResolvedValue(createClientSettings()),
    updateClientSettings: vi.fn().mockResolvedValue(createClientSettings()),
    addBookmark: vi
      .fn()
      .mockImplementation((input: { displayName: string; serverAddress: string }) =>
        Promise.resolve({ bookmarkId: `bm-${input.displayName}`, ...input }),
      ),
    updateBookmark: vi.fn().mockResolvedValue(true),
    removeBookmark: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as DesktopApi;
}

/** Installs the mock on `window.desktopApp` (typed `readonly` in production — see
 * `apps/desktop/src/renderer/global.d.ts` — so this is the one sanctioned place a test bypasses
 * that). Returns the mock for further per-test method overrides/assertions. Callers are
 * responsible for restoring/reassigning between tests if they rely on isolation beyond what a
 * fresh `createDesktopAppMock()` per test already gives (every test in this suite calls this once
 * per `it`, never sharing a mock instance across tests). */
export function installDesktopAppMock(overrides: Partial<DesktopApi> = {}): DesktopApi {
  const mock = createDesktopAppMock(overrides);
  Object.defineProperty(window, 'desktopApp', {
    value: mock,
    configurable: true,
    writable: true,
  });
  return mock;
}
