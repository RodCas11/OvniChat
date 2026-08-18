import { useEffect, useState, type ReactElement } from 'react';

import type { DesktopVersionInfo } from '../shared/ipc-contract.js';

type BridgeState =
  | { status: 'loading' }
  | { status: 'ready'; info: DesktopVersionInfo }
  | { status: 'error'; message: string };

const NOT_IMPLEMENTED = [
  'Servers and channels',
  'Voice, microphone, camera, screen sharing',
  'Text chat',
  'Realtime signaling and self-hosted backend',
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

export function App(): ReactElement {
  const bridge = useBridgeState();

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
