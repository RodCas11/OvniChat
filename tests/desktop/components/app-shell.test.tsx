// @vitest-environment jsdom
//
// Composition-level test for `AppShell` — mocks the heavy `VoiceChannelView` (its own real
// `useVoiceChannel` hook owns a live WebSocket/WebRTC stack, out of scope for a component test; see
// `use-voice-channel-*.test.ts` and the real two-client E2E scripts for that boundary) to prove
// `AppShell` itself correctly composes `ServerRail` alongside it and threads props through
// unchanged.
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClientSettings, installDesktopAppMock } from '../fixtures/desktop-app-mock.js';

vi.mock('../../../apps/desktop/src/renderer/voice/VoiceChannelView.js', () => ({
  VoiceChannelView: ({ nickname }: { readonly nickname: string }) => (
    <div data-testid="voice-channel-view-stub">{nickname}</div>
  ),
}));

const { AppShell } = await import('../../../apps/desktop/src/renderer/shell/AppShell.js');
const { createIdentity } = await import('../fixtures/desktop-app-mock.js');

afterEach(() => {
  cleanup();
});

describe('AppShell (T13.1)', () => {
  it('renders the server rail alongside the workspace, and threads props through to it', async () => {
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(
        createClientSettings({
          bookmarks: [
            { bookmarkId: 'a', displayName: 'Server A', serverAddress: '127.0.0.1:8090' },
          ],
        }),
      ),
    });

    render(
      <AppShell
        realtimeConfig={{ url: 'ws://127.0.0.1:8090', iceServers: [] }}
        e2eAutoJoin={undefined}
        defaultDisplayName="Alice"
        identity={createIdentity()}
        nickname="Alice"
        onNicknameChange={vi.fn()}
        onRegenerateIdentity={vi.fn()}
        activeServerAddress="127.0.0.1:8090"
        onSwitchServer={vi.fn()}
        onGoHome={vi.fn()}
      />,
    );

    expect(screen.getByRole('navigation', { name: 'Servers' })).toBeInTheDocument();
    expect(await screen.findByTestId('server-rail-tile-a')).toBeInTheDocument();
    expect(screen.getByTestId('voice-channel-view-stub')).toHaveTextContent('Alice');
  });
});
