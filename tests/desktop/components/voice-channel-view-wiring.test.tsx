// @vitest-environment jsdom
//
// T13.2 QA — real `VoiceChannelView.tsx`-level wiring proofs that stop short of the pure-function/
// prop-drilled component tests elsewhere in this suite:
//   1. `chat-target.test.ts` already proves `resolveChatTargetAfterCatalogUpdate` in pure isolation;
//      this proves `VoiceChannelView.tsx`'s own effect actually calls it on a live `state.channelTree`
//      change and that the fallback is real UI behavior — composer, header title, and the previously-
//      shown channel chat all reset to Server Chat, not merely a value a unit test observed in
//      isolation.
//   2. `normal-user-no-admin-dom.test.tsx` proves `MainContent` never renders a Server Settings gear
//      when handed `onOpenServerSettings={undefined}` directly; this proves the real
//      `canOpenServerSettings` derivation inside `VoiceChannelView.tsx` itself is what decides that,
//      and that the gear (once shown) actually opens the real `ServerSettingsModal`.
// Mocks only the heavy `useVoiceChannel` hook (its own real WebSocket/WebRTC stack is out of scope
// for a component test, per this repo's existing `app-shell.test.tsx` precedent) — every other module
// (`MainContent`, `ChannelSidebar`, `ChatView`, `ServerSettingsModal`,
// `resolveChatTargetAfterCatalogUpdate` itself) stays real.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../apps/desktop/src/renderer/ui/ToastProvider.js';
import { createIdentity, installDesktopAppMock } from '../fixtures/desktop-app-mock.js';
import { createChannel, createVoiceActions, createVoiceState } from '../fixtures/voice-state.js';

vi.mock('../../../apps/desktop/src/renderer/voice/use-voice-channel.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../apps/desktop/src/renderer/voice/use-voice-channel.js')
    >();
  return { ...actual, useVoiceChannel: vi.fn() };
});

import { useVoiceChannel } from '../../../apps/desktop/src/renderer/voice/use-voice-channel.js';
import { VoiceChannelView } from '../../../apps/desktop/src/renderer/voice/VoiceChannelView.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  installDesktopAppMock();
});

function renderView() {
  return render(
    <ToastProvider>
      <VoiceChannelView
        realtimeConfig={{ url: 'ws://127.0.0.1:8090', iceServers: [] }}
        identity={createIdentity()}
        nickname="Nova"
        onNicknameChange={vi.fn().mockResolvedValue(true)}
        onRegenerateIdentity={vi.fn().mockResolvedValue(undefined)}
      />
    </ToastProvider>,
  );
}

describe('VoiceChannelView — selected-channel-removed fallback wiring (T13.2)', () => {
  it('resets composer, header, and chat view to Server Chat when the selected channel disappears from a live catalog update', async () => {
    const actions = createVoiceActions();
    const channelTree = [createChannel({ nodeId: 'general', name: 'General' })];
    const mockedUseVoiceChannel = vi.mocked(useVoiceChannel);
    mockedUseVoiceChannel.mockReturnValue([
      createVoiceState({ channelTree, myPermissions: ['chat.channel.send', 'chat.server.send'] }),
      actions,
    ]);

    const { rerender } = renderView();

    // A plain click selects the channel's chat (never joins voice).
    fireEvent.click(screen.getByTestId('channel-row-select-general'));
    const header = document.querySelector('header');
    expect(header?.textContent).toContain('General — Chat');

    // An unsent composer draft proves this is a real UI reset, not just a header-text change.
    fireEvent.change(screen.getByPlaceholderText('Message…'), {
      target: { value: 'a draft nobody sent yet' },
    });
    expect(screen.getByDisplayValue('a draft nobody sent yet')).toBeInTheDocument();

    // Live catalog update on the exact same connection (no reconnect): the channel is now gone —
    // deleted by an admin, or hidden by a live ACL change (`ChannelNodeView`'s own "absent, never
    // present-but-marked-hidden" privacy guarantee means both look identical from here).
    mockedUseVoiceChannel.mockReturnValue([
      createVoiceState({
        channelTree: [],
        myPermissions: ['chat.channel.send', 'chat.server.send'],
      }),
      actions,
    ]);
    rerender(
      <ToastProvider>
        <VoiceChannelView
          realtimeConfig={{ url: 'ws://127.0.0.1:8090', iceServers: [] }}
          identity={createIdentity()}
          nickname="Nova"
          onNicknameChange={vi.fn().mockResolvedValue(true)}
          onRegenerateIdentity={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(document.querySelector('header')?.textContent).toContain('Server Chat');
    });
    expect(document.querySelector('header')?.textContent).not.toContain('General — Chat');
    expect(screen.queryByDisplayValue('a draft nobody sent yet')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message…')).toHaveValue('');
  });
});

describe('VoiceChannelView — Server Settings entry point (`canOpenServerSettings`, T13.2)', () => {
  it('a Guest with no channel-admin/groups/tokens/bans permission sees no Server Settings gear at all', () => {
    const actions = createVoiceActions();
    vi.mocked(useVoiceChannel).mockReturnValue([createVoiceState({ myPermissions: [] }), actions]);

    renderView();

    expect(screen.queryByTestId('open-server-settings')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Open Server Settings')).not.toBeInTheDocument();
  });

  it('an identity holding channels.create sees the Server Settings gear, and it opens the real shell', () => {
    const actions = createVoiceActions({
      getEditableChannelNode: vi.fn().mockRejectedValue(new Error('denied')),
    });
    vi.mocked(useVoiceChannel).mockReturnValue([
      createVoiceState({ myPermissions: ['channels.create'] }),
      actions,
    ]);

    renderView();

    const gear = screen.getByTestId('open-server-settings');
    fireEvent.click(gear);

    expect(screen.getByTestId('server-settings-modal')).toBeInTheDocument();
    expect(screen.getByTestId('channels-admin-create-category')).toBeInTheDocument();
  });
});
