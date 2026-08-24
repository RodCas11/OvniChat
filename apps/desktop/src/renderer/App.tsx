import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type {
  DesktopE2EScreenshotConfig,
  DesktopE2ESettingsPersistenceConfig,
  DesktopE2EVoiceConfig,
  DesktopRealtimeConfig,
} from '../shared/ipc-contract.js';
import { parseServerAddress } from './connection/parse-server-address.js';
import { FirstRunPrompt } from './identity/FirstRunPrompt.js';
import { IdentityErrorScreen } from './identity/IdentityErrorScreen.js';
import { useIdentity } from './identity/use-identity.js';
import { AppShell } from './shell/AppShell.js';
import { ServerHome } from './shell/ServerHome.js';
import type { VoiceChannelConnectionConfig } from './voice/use-voice-channel.js';

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

/** T13.1 screenshot-capture tooling only — arms `apps/desktop/scripts/e2e-screenshot-capture.mjs`'s
 * Home-screen shot; see `DesktopE2EScreenshotConfig`'s doc comment. `undefined` for every real user
 * and every other scenario. Mirrors `useE2ESettingsPersistenceConfig` exactly. */
function useE2EScreenshotConfig(): DesktopE2EScreenshotConfig | undefined {
  const [config, setConfig] = useState<DesktopE2EScreenshotConfig>();

  useEffect(() => {
    let cancelled = false;

    window.desktopApp
      .getE2EScreenshotConfig()
      .then((result) => {
        if (!cancelled && result) setConfig(result);
      })
      .catch((error: unknown) => {
        console.error('Failed to load E2E screenshot config', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}

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
      <h1>Chantivo</h1>
      <p>Setting up local identity for automated testing…</p>
    </main>
  );
}

/** Non-interactive stand-in for `ServerHome`, used only for the E2E smoke tests — connects
 * to the deployment-default server address as soon as it mounts, with no human interaction. Only
 * reachable when `e2eVoiceConfig` is defined, which Main only ever supplies when
 * `!app.isPackaged` (see `main/window.ts`) — a real, packaged build always sees the real,
 * interactive `ServerHome`. */
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
      <h1>Chantivo</h1>
      <p>Connecting to the test server…</p>
    </main>
  );
}

type ServerConnectionState =
  | { readonly status: 'disconnected' }
  | { readonly status: 'connected'; readonly config: VoiceChannelConnectionConfig };

export function App(): ReactElement {
  const defaultRealtimeConfig = useDefaultRealtimeConfig();
  const e2eVoiceConfig = useE2EVoiceConfig();
  const e2eSettingsPersistenceConfig = useE2ESettingsPersistenceConfig();
  const e2eScreenshotConfig = useE2EScreenshotConfig();
  const startupConnectPreference = useStartupConnectPreference();
  const identity = useIdentity();
  const [connection, setConnection] = useState<ServerConnectionState>({ status: 'disconnected' });
  /**
   * T13.1 — a monotonic counter bumped on every `connectTo` call, so `AppShell`'s own `key` (see
   * `shell/AppShell.tsx`'s doc comment) changes on *every* connection sequence, even switching
   * between two bookmarks that happen to share the same `host:port` (same-URL reconnects would
   * otherwise produce the same `key` and fail to force a remount). Combined with the connection
   * URL itself in the actual `key` expression below, purely so a same-URL-but-different-sequence
   * switch is still guaranteed a fresh `AppShell`/`VoiceChannelView` instance.
   */
  const connectionSequenceRef = useRef(0);

  const connectTo = useCallback(
    (url: string, serverToken?: string) => {
      connectionSequenceRef.current += 1;
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
      // `ServerHome`'s pre-filled default address from the deployment default.
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

  /**
   * T13.1 — the server rail's "switch server" action. Reuses the exact same `disconnect()` ->
   * `connectTo()` lifecycle a manual disconnect-then-reconnect would use — never a second
   * simultaneous connection. React 19 may batch both state updates from this one handler into a
   * single commit (skipping an intermediate rendered `disconnected` state entirely) — this is
   * exactly why `AppShell`'s remount `key` (derived from `connectionSequenceRef` above, bumped
   * inside `connectTo`) exists: it guarantees a fresh component instance on every switch
   * regardless of how React batches the underlying state transition.
   */
  const switchServer = useCallback(
    (url: string) => {
      disconnect();
      connectTo(url);
    },
    [disconnect, connectTo],
  );

  /**
   * T13.1 product-shell-smoke only (`e2e-product-shell-smoke.mjs`) — seeds two real bookmarks via
   * the exact same production `addBookmark` IPC `AddServerDialog` drives, before the E2E
   * `AutoConnect` path (below) is allowed to fire, so the script gets a genuine window in which the
   * real `ServerHome` renders both bookmarks (see the `AutoConnect` branch's own gating on
   * `pssBookmarksSeeded`). Logs a settings snapshot marker once both are saved — the script's proof
   * that bookmark seeding actually persisted, mirroring `e2eSettingsPersistenceAttempted`'s own
   * snapshot-marker pattern above. `undefined` for every other scenario and every real user.
   */
  const [pssBookmarksSeeded, setPssBookmarksSeeded] = useState(false);
  const pssSeedAttempted = useRef(false);
  useEffect(() => {
    const productShellSmoke = e2eVoiceConfig?.productShellSmoke;
    if (!productShellSmoke || pssSeedAttempted.current) return;
    pssSeedAttempted.current = true;

    void (async () => {
      try {
        await window.desktopApp.addBookmark(productShellSmoke.bookmarkA);
        await window.desktopApp.addBookmark(productShellSmoke.bookmarkB);
        const settings = await window.desktopApp.getClientSettings();
        console.info(
          `E2E_PRODUCT_SHELL_HOME_BOOKMARKS:${JSON.stringify(
            settings.bookmarks.map((bookmark) => bookmark.displayName),
          )}`,
        );
        setPssBookmarksSeeded(true);
      } catch (error) {
        console.error('E2E product-shell-smoke bookmark seeding failed', error);
      }
    })();
  }, [e2eVoiceConfig]);

  /**
   * T13.1 product-shell-smoke only — once connected to bookmark A (the scenario's first server),
   * switches to bookmark B via the exact same `switchServer` (disconnect -> connect) lifecycle the
   * real `ServerRail` drives, after a fixed delay generous enough for the rest of this connection's
   * own scripted automation (channel selection, join, settings open/close — see
   * `VoiceChannelView.tsx`'s own product-shell-smoke effects) to finish first.
   */
  const PSS_SWITCH_TO_B_AFTER_MS = 6_000;
  const pssSwitchAttempted = useRef(false);
  useEffect(() => {
    const productShellSmoke = e2eVoiceConfig?.productShellSmoke;
    if (!productShellSmoke || pssSwitchAttempted.current) return;
    if (connection.status !== 'connected') return;

    const parsedB = parseServerAddress(productShellSmoke.bookmarkB.serverAddress);
    if (!parsedB.ok) {
      console.error('E2E product-shell-smoke: bookmark B address invalid', parsedB.reason);
      return;
    }
    pssSwitchAttempted.current = true;

    const timer = setTimeout(() => {
      console.info('E2E_PRODUCT_SHELL_SWITCHING_TO_B');
      switchServer(parsedB.address.url);
    }, PSS_SWITCH_TO_B_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [e2eVoiceConfig, connection.status, switchServer]);

  /**
   * T13.1 product-shell-smoke only — once actually connected to bookmark B (never to A, which the
   * effect above is already moving away from), waits for that connection's own scripted automation
   * to finish, then disconnects back to `ServerHome` via the same real `disconnect()` a user's Home
   * button drives, logging a final settings snapshot first — the script's proof that both bookmarks
   * survived the entire switch/disconnect sequence untouched.
   */
  const PSS_DISCONNECT_AFTER_MS = 4_000;
  const pssDisconnectAttempted = useRef(false);
  useEffect(() => {
    const productShellSmoke = e2eVoiceConfig?.productShellSmoke;
    if (!productShellSmoke || pssDisconnectAttempted.current) return;
    if (connection.status !== 'connected') return;

    const parsedB = parseServerAddress(productShellSmoke.bookmarkB.serverAddress);
    if (!parsedB.ok || connection.config.url !== parsedB.address.url) return;
    pssDisconnectAttempted.current = true;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const settings = await window.desktopApp.getClientSettings();
          console.info(
            `E2E_PRODUCT_SHELL_DONE:${JSON.stringify({
              bookmarkNames: settings.bookmarks.map((bookmark) => bookmark.displayName),
            })}`,
          );
        } catch (error) {
          console.error('E2E product-shell-smoke final settings snapshot failed', error);
        } finally {
          disconnect();
        }
      })();
    }, PSS_DISCONNECT_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [e2eVoiceConfig, connection, disconnect]);

  // T11 Section 15-16 — a real, production auto-connect for a user who explicitly opted in via
  // Settings > Advanced's "Connect automatically on startup" checkbox (T13.1: relocated from the
  // retired `ConnectionScreen.tsx`). Deliberately structured as its
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
      // launch — the user still sees the ordinary `ServerHome`/`AddServerDialog` flow, unaffected
      // by this invalid persisted value (it is simply never used to auto-connect).
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

  /**
   * T13.1 screenshot-capture tooling only (`e2e-screenshot-capture.mjs`) — seeds two real bookmarks
   * via the exact same production `addBookmark` IPC `AddServerDialog` drives, so the script's Main
   * process can capture a real `ServerHome` showing both. Deliberately fires as soon as identity is
   * `ready`, *before* checking whether a nickname exists — `ServerHome` only ever mounts once a
   * nickname is set (see the `nickname === ''` branch below), and `ServerHome`'s own `useBookmarks()`
   * fetches `getClientSettings()` exactly once, on its own mount, with no live-refresh afterward (see
   * `connection/use-bookmarks.ts`'s doc comment). Seeding only after a nickname already existed would
   * race that one-shot fetch — `AutoFirstRun`'s own nickname-submission IPC round trip below is what
   * actually guarantees these two `addBookmark` calls have landed before `ServerHome` ever mounts and
   * takes its one snapshot, not this effect's own ordering by itself. Deliberately never connects
   * anywhere — unlike `e2eVoiceConfig`, this config's mere presence does not gate `AutoConnect`
   * below, so the real `ServerHome` stays rendered indefinitely for the capture. Also drives the
   * nickname submission itself (via the same real `identity.setNickname` `FirstRunPrompt` uses),
   * strictly *after* both bookmarks are persisted — never a separately-timed `AutoFirstRun` — so
   * `ServerHome`'s own one-shot `getClientSettings()` fetch (see `connection/use-bookmarks.ts`'s doc
   * comment: it never re-fetches after mount) cannot land before seeding finishes.
   */
  const screenshotBookmarksSeeded = useRef(false);
  useEffect(() => {
    if (!e2eScreenshotConfig || screenshotBookmarksSeeded.current) return;
    if (identity.state.status !== 'ready') return;
    screenshotBookmarksSeeded.current = true;
    const needsNickname = identity.state.nickname === '';

    void (async () => {
      try {
        await window.desktopApp.addBookmark(e2eScreenshotConfig.bookmarkA);
        await window.desktopApp.addBookmark(e2eScreenshotConfig.bookmarkB);
        if (needsNickname) {
          await identity.setNickname(e2eScreenshotConfig.displayName);
        }
        console.info('E2E_SCREENSHOT_HOME_READY');
      } catch (error) {
        console.error('E2E screenshot-capture bookmark seeding failed', error);
      }
    })();
  }, [e2eScreenshotConfig, identity.state, identity.setNickname]);

  if (identity.state.status === 'error') {
    return (
      <IdentityErrorScreen message={identity.state.message} onRegenerate={identity.regenerate} />
    );
  }

  if (identity.state.status === 'loading') {
    return (
      <main>
        <h1>Chantivo</h1>
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
    // T13.1 screenshot-capture tooling only: deliberately renders the plain `FirstRunPrompt` here
    // (never a second, independent `AutoFirstRun`) — `screenshotBookmarksSeeded`'s own effect above
    // calls `identity.setNickname` itself, strictly *after* both bookmarks are already persisted, so
    // a second, independently-timed nickname submission racing it (as an `AutoFirstRun` mounted here
    // would) could flip the nickname first and let `ServerHome` mount/fetch before seeding finishes
    // — see that effect's doc comment for the full race this avoids.
    return <FirstRunPrompt onContinue={identity.setNickname} />;
  }

  const { nickname: currentNickname, identity: publicIdentity } = identity.state;

  // T8: the client no longer behaves like it has one implicit development server — connecting is
  // now an explicit, user-driven step (`ServerHome`) rather than automatic on launch. The E2E
  // smoke tests need the equivalent of that step to happen non-interactively instead.
  if (connection.status === 'disconnected') {
    // T13.1 product-shell-smoke: while bookmarks are still being seeded (see the
    // `pssBookmarksSeeded` effect above), deliberately falls through to the real `ServerHome`
    // below instead of `AutoConnect` — a genuine window in which the script's two bookmarks are
    // actually visible on the real Home screen before the scenario connects anywhere. Every other
    // scenario (`productShellSmoke` absent) is unaffected: this condition is trivially true then.
    if (
      e2eVoiceConfig &&
      defaultRealtimeConfig &&
      (!e2eVoiceConfig.productShellSmoke || pssBookmarksSeeded)
    ) {
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
      <ServerHome
        onConnect={connectTo}
        connectionError={undefined}
        identity={publicIdentity}
        nickname={currentNickname}
        onNicknameChange={identity.setNickname}
        onRegenerateIdentity={identity.regenerate}
      />
    );
  }

  // T13.1 — `key` changes on every connection sequence (see `switchServer`'s and
  // `connectionSequenceRef`'s own doc comments above, and `AppShell.tsx`'s doc comment for why this
  // is a correctness requirement, not a nice-to-have): React always fully unmounts the previous
  // `AppShell`/`VoiceChannelView` instance and mounts a fresh one on every switch, so no local UI
  // state (draft chat text, selected channel, open settings, device-picker selections) ever leaks
  // from one server into another.
  return (
    <AppShell
      key={`${connection.config.url}#${String(connectionSequenceRef.current)}`}
      realtimeConfig={connection.config}
      e2eAutoJoin={e2eVoiceConfig}
      defaultDisplayName={currentNickname}
      identity={publicIdentity}
      nickname={currentNickname}
      onNicknameChange={identity.setNickname}
      onRegenerateIdentity={identity.regenerate}
      activeServerAddress={connection.config.url.replace(/^wss?:\/\//u, '')}
      onSwitchServer={switchServer}
      onGoHome={disconnect}
    />
  );
}
