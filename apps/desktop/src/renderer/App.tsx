import { useEffect, useState, type ReactElement } from 'react';

import type {
  DesktopE2EVoiceConfig,
  DesktopRealtimeConfig,
  DesktopVersionInfo,
} from '../shared/ipc-contract.js';
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

export function App(): ReactElement {
  const bridge = useBridgeState();
  const realtimeConfig = useRealtimeConfig();
  const e2eVoiceConfig = useE2EVoiceConfig();

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

      <VoiceChannelView realtimeConfig={realtimeConfig} e2eAutoJoin={e2eVoiceConfig} />

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
