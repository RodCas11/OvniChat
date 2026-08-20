import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type {
  DesktopE2ESettingsPersistenceConfig,
  DesktopE2EVoiceConfig,
  DesktopRealtimeConfig,
  DesktopVersionInfo,
} from '../shared/ipc-contract.js';
import { ConnectionScreen } from './connection/ConnectionScreen.js';
import { parseServerAddress } from './connection/parse-server-address.js';
import { FirstRunPrompt } from './identity/FirstRunPrompt.js';
import { IdentityErrorScreen } from './identity/IdentityErrorScreen.js';
import { IdentityPanel } from './identity/IdentityPanel.js';
import { useIdentity } from './identity/use-identity.js';
import type { VoiceChannelConnectionConfig } from './voice/use-voice-channel.js';
import { VoiceChannelView } from './voice/VoiceChannelView.js';

type BridgeState =
  | { status: 'loading' }
  | { status: 'ready'; info: DesktopVersionInfo }
  | { status: 'error'; message: string };

// Stale since T4/T5/T10 shipped camera, screen sharing, and text chat respectively — corrected here
// (found while touching this file for T11) rather than continuing to show a real user false
// information about what OvniChat can already do.
const NOT_IMPLEMENTED = [
  'Servers (multiple guild-style groupings)',
  'Windows per-process/game audio (T12)',
  'Message editing and deletion',
] as const;

function useBridgeState(): BridgeState {
  const [state, setState] = useState<BridgeState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    window.desktopApp
      .getVersionInfo()
      .then((info) => {
        if (!cancelled) setState({ status: 'ready', info });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unknown preload bridge error',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/** The deployment/development default (`DISCO_VOADOR_REALTIME_URL`, see `main/desktop-config.ts`)
 * — a pre-fill convenience for the connection screen and the E2E auto-connect path (T8 Section
 * 22-24), never an auto-connect trigger for a real user: a packaged build ships with no server
 * baked in, and the address field is always editable. `iceServers` remains genuine operator/
 * deployment configuration, reused as-is for whatever server the user actually connects to. */
function useDefaultRealtimeConfig(): DesktopRealtimeConfig | undefined {
  const [config, setConfig] = useState<DesktopRealtimeConfig>();

  useEffect(() => {
    let cancelled = false;

    window.desktopApp
      .getRealtimeConfig()
      .then((result) => {
        if (!cancelled) setConfig(result);
      })
      .catch((error: unknown) => {
        console.error('Failed to load realtime config', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}

/** T11 — loads the persisted "connect automatically on startup" preference once, so `App` can
 * trigger a real, production auto-connect for a genuinely opted-in user (Section 15-16). Entirely
 * separate from the E2E-only `AutoConnect`/`e2eVoiceConfig` path below — see `App()`'s own startup
 * auto-connect effect for why the two must never share code (this one must work in a packaged
 * build for a real user; `e2eVoiceConfig` never exists in one at all). */
function useStartupConnectPreference():
  { readonly serverAddress: string; readonly connectOnStartup: boolean } | undefined {
  const [preference, setPreference] = useState<{
    readonly serverAddress: string;
    readonly connectOnStartup: boolean;
  }>();

  useEffect(() => {
    let cancelled = false;

    window.desktopApp
      .getClientSettings()
      .then((settings) => {
        if (!cancelled) {
          setPreference({
            serverAddress: settings.lastServerAddress ?? '',
            connectOnStartup: settings.connectOnStartup,
          });
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load startup connect preference', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return preference;
}

/** T11 — arms the settings-persistence E2E script (`e2e-settings-persistence.mjs`) only:
 * `!app.isPackaged`-gated at Main (see `main/window.ts`), mirroring every other
 * `DISCO_VOADOR_E2E_*` flag in this codebase. `undefined` for every real user, always. */
function useE2ESettingsPersistenceConfig(): DesktopE2ESettingsPersistenceConfig | undefined {
  const [config, setConfig] = useState<DesktopE2ESettingsPersistenceConfig>();

  useEffect(() => {
    let cancelled = false;

    window.desktopApp
      .getE2ESettingsPersistenceConfig()
      .then((result) => {
        if (!cancelled && result) setConfig(result);
      })
      .catch((error: unknown) => {
        console.error('Failed to load E2E settings-persistence config', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}

/** T11 — the fixed, deterministic bookmark/device-preference values
 * `e2e-settings-persistence.mjs` asserts against; see `App()`'s own settings-persistence-automation
 * effect below for the full scenario. */
const E2E_SETTINGS_TEST_BOOKMARK = { displayName: 'E2E Bookmark', serverAddress: '127.0.0.1:9199' };
const E2E_SETTINGS_TEST_DEVICE_ID = 'e2e-settings-test-device';

function useE2EVoiceConfig(): DesktopE2EVoiceConfig | undefined {
  const [config, setConfig] = useState<DesktopE2EVoiceConfig>();

  useEffect(() => {
    let cancelled = false;

    window.desktopApp
      .getE2EVoiceConfig()
      .then((result) => {
        if (!cancelled && result) setConfig(result);
      })
      .catch((error: unknown) => {
        console.error('Failed to load E2E voice config', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}

/** Non-interactive stand-in for `FirstRunPrompt`, used only for the E2E smoke tests (see the
 * `e2eVoiceConfig` branch above) — submits the configured display name as the nickname as soon as
 * it mounts, with no human interaction. */
function AutoFirstRun({
  displayName,
  setNickname,
}: {
  readonly displayName: string;
  readonly setNickname: (nickname: string) => Promise<boolean>;
}): ReactElement {
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    setNickname(displayName).catch((error: unknown) => {
      console.error('E2E auto first-run failed to set nickname', error);
    });
  }, [displayName, setNickname]);

  return (
    <main>
      <h1>OvniChat</h1>
      <p>Setting up local identity for automated testing…</p>
    </main>
  );
}

/** Non-interactive stand-in for `ConnectionScreen`, used only for the E2E smoke tests — connects
 * to the deployment-default server address as soon as it mounts, with no human interaction. Only
 * reachable when `e2eVoiceConfig` is defined, which Main only ever supplies when
 * `!app.isPackaged` (see `main/window.ts`) — a real, packaged build always sees the real,
 * interactive `ConnectionScreen`. */
function AutoConnect({
  url,
  onConnect,
}: {
  readonly url: string;
  readonly onConnect: (url: string) => void;
}): ReactElement {
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    onConnect(url);
  }, [url, onConnect]);

  return (
    <main>
      <h1>OvniChat</h1>
      <p>Connecting to the test server…</p>
    </main>
  );
}

type ServerConnectionState =
  | { readonly status: 'disconnected' }
  | { readonly status: 'connected'; readonly config: VoiceChannelConnectionConfig };

export function App(): ReactElement {
  const bridge = useBridgeState();
  const defaultRealtimeConfig = useDefaultRealtimeConfig();
  const e2eVoiceConfig = useE2EVoiceConfig();
  const e2eSettingsPersistenceConfig = useE2ESettingsPersistenceConfig();
  const startupConnectPreference = useStartupConnectPreference();
  const identity = useIdentity();
  const [connection, setConnection] = useState<ServerConnectionState>({ status: 'disconnected' });

  const connectTo = useCallback(
    (url: string, serverToken?: string) => {
      setConnection({
        status: 'connected',
        config: {
          url,
          iceServers: defaultRealtimeConfig?.iceServers ?? [],
          ...(serverToken ? { serverToken } : {}),
        },
      });
      // T11 Section 13 — every connection attempt (manual entry or a bookmark) funnels through this
      // one place, so this is the single spot that remembers the last address for next launch's
      // pre-fill/auto-connect. `parse-server-address.ts` only ever produces a `ws://` URL (never
      // `wss://`), so stripping the scheme back off losslessly recovers the plain "host:port" the
      // user actually typed/saved — the exact same regex this file already uses below to compute
      // `ConnectionScreen`'s `defaultAddress` prop from the deployment default.
      window.desktopApp
        .updateClientSettings({ lastServerAddress: url.replace(/^wss?:\/\//u, '') })
        .catch((error: unknown) => {
          console.error('Failed to persist last server address', error);
        });
    },
    [defaultRealtimeConfig],
  );

  const disconnect = useCallback(() => {
    setConnection({ status: 'disconnected' });
  }, []);

  // T11 Section 15-16 — a real, production auto-connect for a user who explicitly opted in via
  // `ConnectionScreen`'s "Connect automatically on startup" checkbox. Deliberately structured as its
  // own effect/state, never sharing code with the E2E-only `AutoConnect`/`e2eVoiceConfig` path above:
  // that path is structurally similar (both eventually call `connectTo` once, unattended) but is
  // gated to never exist at all in a packaged build, whereas this one is a real feature that must
  // work in one. Still goes through the full T7 identity handshake and T9 admission normally via the
  // ordinary `connectTo` call — no shortcut, no bypass of either.
  const autoStartupConnectAttempted = useRef(false);
  useEffect(() => {
    if (e2eVoiceConfig) return; // never applies to the E2E auto-connect scenarios above
    if (autoStartupConnectAttempted.current) return;
    if (connection.status !== 'disconnected') return;
    if (identity.state.status !== 'ready') return;
    if (identity.state.nickname === '') return;
    if (!startupConnectPreference?.connectOnStartup) return;
    if (startupConnectPreference.serverAddress === '') return;

    const parsed = parseServerAddress(startupConnectPreference.serverAddress);
    if (!parsed.ok) {
      // A corrupted/unparseable persisted address is not worth surfacing as a connection error on
      // launch — the user still sees the ordinary `ConnectionScreen` with this same (now-visibly
      // invalid) value pre-filled and can fix it there.
      console.error('Startup auto-connect: persisted server address is invalid', parsed.reason);
      autoStartupConnectAttempted.current = true;
      return;
    }

    autoStartupConnectAttempted.current = true;
    connectTo(parsed.address.url);
  }, [e2eVoiceConfig, connection.status, identity.state, startupConnectPreference, connectTo]);

  /**
   * Drives `apps/desktop/scripts/e2e-settings-persistence.mjs` — proves the T11 settings store
   * survives real app restarts against the same `--user-data-dir` and never leaks across a
   * different one. `write` (only set on the orchestrating script's *first* launch of a given
   * profile) adds one fixed, deterministic bookmark and sets one fixed device preference through
   * the exact same production `addBookmark`/`updateClientSettings` IPC the real Settings/Bookmarks
   * UI drives — never a hand-crafted `settings.json`. Every launch (write or not) then reads back
   * and logs the full current settings snapshot via a `disco-voador:e2e-settings-snapshot:<json>`
   * console line, relayed to stdout (and used to trigger an orderly `app.exit()`) by
   * `main/index.ts`'s `armE2ESettingsPersistenceExit`, for the
   * orchestrating script to assert against. Runs as a plain effect (not a mounted child component)
   * specifically so it fires regardless of which identity/connection screen `App()` is currently
   * returning below — settings/bookmarks are independent of both, and `App()` has several early
   * `return`s that a child component could otherwise fail to ever mount under.
   */
  const e2eSettingsPersistenceAttempted = useRef(false);
  useEffect(() => {
    if (!e2eSettingsPersistenceConfig || e2eSettingsPersistenceAttempted.current) return;
    e2eSettingsPersistenceAttempted.current = true;

    void (async () => {
      try {
        if (e2eSettingsPersistenceConfig.write) {
          await window.desktopApp.addBookmark(E2E_SETTINGS_TEST_BOOKMARK);
          await window.desktopApp.updateClientSettings({
            audio: { inputDeviceId: E2E_SETTINGS_TEST_DEVICE_ID },
          });
        }
        const settings = await window.desktopApp.getClientSettings();
        console.info(`disco-voador:e2e-settings-snapshot:${JSON.stringify(settings)}`);
      } catch (error) {
        console.error('E2E settings persistence automation failed', error);
      }
    })();
  }, [e2eSettingsPersistenceConfig]);

  if (identity.state.status === 'error') {
    return (
      <IdentityErrorScreen message={identity.state.message} onRegenerate={identity.regenerate} />
    );
  }

  if (identity.state.status === 'loading') {
    return (
      <main>
        <h1>OvniChat</h1>
        <p>Loading local identity…</p>
      </main>
    );
  }

  if (identity.state.nickname === '') {
    if (e2eVoiceConfig) {
      return (
        <AutoFirstRun displayName={e2eVoiceConfig.displayName} setNickname={identity.setNickname} />
      );
    }
    return <FirstRunPrompt onContinue={identity.setNickname} />;
  }

  const { nickname: currentNickname, identity: publicIdentity } = identity.state;

  // T8: the client no longer behaves like it has one implicit development server — connecting is
  // now an explicit, user-driven step (`ConnectionScreen`) rather than automatic on launch. The
  // E2E smoke tests need the equivalent of that step to happen non-interactively instead.
  if (connection.status === 'disconnected') {
    if (e2eVoiceConfig && defaultRealtimeConfig) {
      // `connectUrl` (T8) lets a test connect somewhere other than the CSP-relevant deployment
      // default — see `DesktopE2EVoiceConfig.connectUrl`'s doc comment.
      return (
        <AutoConnect
          url={e2eVoiceConfig.connectUrl ?? defaultRealtimeConfig.url}
          onConnect={connectTo}
        />
      );
    }
    return (
      <ConnectionScreen
        nickname={currentNickname}
        defaultAddress={defaultRealtimeConfig?.url.replace(/^wss?:\/\//u, '')}
        onConnect={connectTo}
        connecting={false}
        connectionError={undefined}
      />
    );
  }

  return (
    <main>
      <h1>OvniChat</h1>
      <p>Desktop client foundation</p>
      <dl>
        <dt>Electron</dt>
        <dd>{bridge.status === 'ready' ? bridge.info.electronVersion : '…'}</dd>
        <dt>App version</dt>
        <dd>{bridge.status === 'ready' ? bridge.info.appVersion : '…'}</dd>
      </dl>
      <p>
        <strong>T1 Electron Shell</strong> — {bridge.status === 'ready' && 'Ready'}
        {bridge.status === 'loading' && 'Starting…'}
        {bridge.status === 'error' && `Preload bridge error: ${bridge.message}`}
      </p>
      <p>
        <button type="button" onClick={disconnect}>
          Disconnect
        </button>
      </p>

      <IdentityPanel
        nickname={currentNickname}
        identity={publicIdentity}
        onNicknameChange={identity.setNickname}
        onRegenerate={identity.regenerate}
      />

      <VoiceChannelView
        realtimeConfig={connection.config}
        e2eAutoJoin={e2eVoiceConfig}
        defaultDisplayName={currentNickname}
      />

      <section>
        <h2>Not implemented yet</h2>
        <ul>
          {NOT_IMPLEMENTED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
