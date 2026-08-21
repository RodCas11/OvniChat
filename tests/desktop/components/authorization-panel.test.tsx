// @vitest-environment jsdom
//
// T13.1: admin/moderation UI must be *absent* (not merely disabled) when the connected user's
// `myPermissions` does not include the relevant `PermissionKey` — `AuthorizationPanel.tsx`'s
// pre-existing `can(permission)` gating (T9) is unchanged by the redesign; this proves it still
// works.
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthorizationPanel } from '../../../apps/desktop/src/renderer/voice/AuthorizationPanel.js';
import { createVoiceActions, createVoiceState } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('AuthorizationPanel (T13.1 — admin UI hidden, not merely disabled, without permission)', () => {
  it('shows no admin sections for a Guest with no elevated permissions', () => {
    render(
      <AuthorizationPanel
        state={createVoiceState({ myPermissions: [] })}
        actions={createVoiceActions()}
      />,
    );

    expect(screen.queryByText('Tokens')).not.toBeInTheDocument();
    expect(screen.queryByText('Groups')).not.toBeInTheDocument();
    expect(screen.queryByText('Bans')).not.toBeInTheDocument();
    expect(screen.queryByText('Participants')).not.toBeInTheDocument();
    // The redeem-token form is always present — every connected user, not admin-only.
    expect(screen.getByText('Privilege key / invite token')).toBeInTheDocument();
  });

  it('shows the Tokens section only when authorization.tokens.manage is granted', () => {
    render(
      <AuthorizationPanel
        state={createVoiceState({ myPermissions: ['authorization.tokens.manage'] })}
        actions={createVoiceActions()}
      />,
    );
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.queryByText('Groups')).not.toBeInTheDocument();
    expect(screen.queryByText('Bans')).not.toBeInTheDocument();
  });

  it('shows the Groups section only when authorization.groups.manage is granted', () => {
    render(
      <AuthorizationPanel
        state={createVoiceState({ myPermissions: ['authorization.groups.manage'] })}
        actions={createVoiceActions()}
      />,
    );
    expect(screen.getByText('Groups')).toBeInTheDocument();
    expect(screen.queryByText('Tokens')).not.toBeInTheDocument();
  });

  it('shows the Bans section only when moderation.ban is granted', () => {
    render(
      <AuthorizationPanel
        state={createVoiceState({ myPermissions: ['moderation.ban'] })}
        actions={createVoiceActions()}
      />,
    );
    expect(screen.getByText('Bans')).toBeInTheDocument();
    expect(screen.queryByText('Groups')).not.toBeInTheDocument();
  });

  it('shows every admin section together for a full server-admin permission set', () => {
    render(
      <AuthorizationPanel
        state={createVoiceState({
          myPermissions: [
            'authorization.tokens.manage',
            'authorization.groups.manage',
            'moderation.ban',
          ],
        })}
        actions={createVoiceActions()}
      />,
    );
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('Groups')).toBeInTheDocument();
    expect(screen.getByText('Bans')).toBeInTheDocument();
  });

  it('shows the Participants section only while in a channel and holding a relevant permission', () => {
    const { rerender } = render(
      <AuthorizationPanel
        state={createVoiceState({
          myPermissions: ['moderation.kick'],
          currentChannelId: undefined,
        })}
        actions={createVoiceActions()}
      />,
    );
    expect(screen.queryByText('Participants')).not.toBeInTheDocument();

    rerender(
      <AuthorizationPanel
        state={createVoiceState({
          myPermissions: ['moderation.kick'],
          currentChannelId: 'general',
        })}
        actions={createVoiceActions()}
      />,
    );
    expect(screen.getByText('Participants')).toBeInTheDocument();
  });
});
