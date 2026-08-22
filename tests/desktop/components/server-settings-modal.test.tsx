// @vitest-environment jsdom
//
// T13.2 — the Server Settings shell: nav switches between Channels/Groups & Permissions/Invites/
// Bans, and each page mounts the same presentation the pre-existing Authorization modal uses
// (no duplicated network calls — same `actions.listGroups`/`actions.listBans`/etc. call sites).
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerSettingsModal } from '../../../apps/desktop/src/renderer/workspace/ServerSettingsModal.js';
import { createVoiceActions, createVoiceState } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('ServerSettingsModal (T13.2)', () => {
  it('defaults to the Channels page and switches pages via the nav', () => {
    const actions = createVoiceActions({
      getEditableChannelNode: vi.fn().mockRejectedValue(new Error('denied')),
    });
    const state = createVoiceState({
      myPermissions: [
        'channels.create',
        'authorization.groups.manage',
        'authorization.tokens.manage',
        'moderation.ban',
      ],
    });

    render(<ServerSettingsModal state={state} actions={actions} onAdminIntent={vi.fn()} />);

    expect(screen.getByTestId('channels-admin-create-category')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('server-settings-nav-groups'));
    expect(
      screen.getByRole('heading', { level: 3, name: 'Groups & Permissions' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('server-settings-nav-invites'));
    expect(screen.getByRole('heading', { level: 3, name: 'Invites' })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('server-settings-nav-bans'));
    expect(screen.getByRole('heading', { level: 3, name: 'Bans' })).toBeInTheDocument();
  });

  it('a page a Guest has no relevant permission for renders its own empty/no-content state, never a fabricated one', () => {
    const state = createVoiceState({ myPermissions: [] });
    render(
      <ServerSettingsModal
        state={state}
        actions={createVoiceActions({
          getEditableChannelNode: vi.fn().mockRejectedValue(new Error('denied')),
        })}
        onAdminIntent={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('server-settings-nav-bans'));
    // BansSection self-hides entirely without moderation.ban — no fabricated "Bans" list content.
    expect(screen.queryByText('Refresh bans')).not.toBeInTheDocument();
  });

  it('the Groups & Permissions and Invites pages also respect their own real per-section permission gating, mounted inside this shell', () => {
    const state = createVoiceState({ myPermissions: [] });
    render(
      <ServerSettingsModal
        state={state}
        actions={createVoiceActions({
          getEditableChannelNode: vi.fn().mockRejectedValue(new Error('denied')),
        })}
        onAdminIntent={vi.fn()}
      />,
    );

    // "Groups & Permissions" mounts `GroupsSection`, which self-hides its own Groups CRUD content
    // without `authorization.groups.manage` — the page heading still renders (it is this shell's
    // own chrome), but none of that section's real content should leak through for a Guest.
    fireEvent.click(screen.getByTestId('server-settings-nav-groups'));
    expect(screen.queryByText('Refresh groups')).not.toBeInTheDocument();
    expect(screen.queryByText('Create Group')).not.toBeInTheDocument();

    // "Invites" mounts `TokensSection`, which returns `null` entirely without
    // `authorization.tokens.manage`.
    fireEvent.click(screen.getByTestId('server-settings-nav-invites'));
    expect(screen.queryByText('Generate')).not.toBeInTheDocument();
  });
});
