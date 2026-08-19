import { useEffect, useRef, useState, type ReactElement } from 'react';

import type {
  DesktopE2EVoiceConfig,
  DesktopRealtimeConfig,
  DesktopVersionInfo,
} from '../shared/ipc-contract.js';
import { FirstRunPrompt } from './identity/FirstRunPrompt.js';
import { IdentityErrorScreen } from './identity/IdentityErrorScreen.js';
import { IdentityPanel } from './identity/IdentityPanel.js';
import { useIdentity } from './identity/use-identity.js';
import { VoiceChannelView } from './voice/VoiceChannelView.js';

type BridgeState =
  | { status: 'loading' }
  | { status: 'ready'; info: DesktopVersionInfo }
  | { status: 'error'; message: string };

const NOT_IMPLEMENTED = [
  'Servers (multiple guild-style groupings)',
  'Camera and screen sharing',
  'Text chat',
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

function useRealtimeConfig(): DesktopRealtimeConfig | undefined {
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
      <h1>Projeto Disco Voador</h1>
      <p>Setting up local identity for automated testing…</p>
    </main>
  );
}

export function App(): ReactElement {
  const bridge = useBridgeState();
  const realtimeConfig = useRealtimeConfig();
  const e2eVoiceConfig = useE2EVoiceConfig();
  const identity = useIdentity();

  if (identity.state.status === 'error') {
    return (
      <IdentityErrorScreen message={identity.state.message} onRegenerate={identity.regenerate} />
    );
  }

  if (identity.state.status === 'loading') {
    return (
      <main>
        <h1>Projeto Disco Voador</h1>
        <p>Loading local identity…</p>
      </main>
    );
  }

  if (identity.state.nickname === '') {
    if (e2eVoiceConfig) {
      // The E2E voice/camera/screen-share smoke tests drive every other step of this app
      // non-interactively; they need the same for the nickname first-run gate, or they would
      // hang waiting for a human to type into `FirstRunPrompt`. Only reachable when
      // `e2eVoiceConfig` is defined, which Main only ever supplies when `!app.isPackaged` (see
      // `main/window.ts`) — a real, packaged build always sees the real, interactive prompt.
      return (
        <AutoFirstRun displayName={e2eVoiceConfig.displayName} setNickname={identity.setNickname} />
      );
    }
    return <FirstRunPrompt onContinue={identity.setNickname} />;
  }

  const { nickname: currentNickname, identity: publicIdentity } = identity.state;

  return (
    <main>
      <h1>Projeto Disco Voador</h1>
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

      <IdentityPanel
        nickname={currentNickname}
        identity={publicIdentity}
        onNicknameChange={identity.setNickname}
        onRegenerate={identity.regenerate}
      />

      <VoiceChannelView
        realtimeConfig={realtimeConfig}
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
