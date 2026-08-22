// @vitest-environment jsdom
//
// T13.2.1 — replaces the raw permission-key dump T13.2's own handoff notes recorded as an accepted,
// out-of-scope rough edge (`AuthorizationPanel.tsx`'s pre-existing rendering via `GroupsSection.tsx`):
// existing groups must render human-readable, categorized permission labels — never a raw
// `PermissionKey` string — and a group holding literally every permission must render a compact "Full
// server administration" summary. The create-group form's checkbox grid is categorized the same way,
// but must still submit the real `PermissionKey` wire values, never a label.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroupsSection } from '../../../apps/desktop/src/renderer/voice/GroupsSection.js';
import { ALL_PERMISSION_KEYS } from '../../../apps/desktop/src/renderer/voice/permission-presentation.js';
import {
  createGroupSummary,
  createVoiceActions,
  createVoiceState,
} from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

const RAW_PERMISSION_KEYS = [
  'voice.channel.join',
  'moderation.kick',
  'moderation.ban',
  'authorization.groups.manage',
  'authorization.memberships.manage',
  'authorization.tokens.manage',
  'server.manage',
  'chat.server.send',
  'chat.channel.send',
  'channels.create',
  'channels.manage',
  'channels.delete',
  'channels.password.bypass',
] as const;

describe('GroupsSection (T13.2.1 — human-readable permission presentation)', () => {
  it('never renders any raw permission key for a group with a representative permission mix', () => {
    const state = createVoiceState({
      myPermissions: ['authorization.groups.manage'],
      groups: [
        createGroupSummary({
          groupId: 'g-mod',
          name: 'Moderator',
          permissions: ['moderation.kick', 'moderation.ban', 'chat.channel.send'],
          protectedGroup: false,
        }),
      ],
    });
    render(<GroupsSection state={state} actions={createVoiceActions()} />);

    for (const rawKey of RAW_PERMISSION_KEYS) {
      expect(screen.queryByText(rawKey, { exact: false })).not.toBeInTheDocument();
    }
    // Real human labels for exactly what this group holds (also present in the always-rendered
    // create-form checkbox grid below, hence `getAllByText` rather than `getByText`).
    expect(screen.getAllByText(/Kick participants/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Ban participants/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Send channel chat/).length).toBeGreaterThan(0);
  });

  it('a group holding literally every current permission renders the full-administration summary, not a 13-item list', () => {
    const state = createVoiceState({
      myPermissions: ['authorization.groups.manage'],
      groups: [
        createGroupSummary({
          groupId: 'g-owner',
          name: 'Owner',
          permissions: [...ALL_PERMISSION_KEYS],
          protectedGroup: false,
        }),
      ],
    });
    render(<GroupsSection state={state} actions={createVoiceActions()} />);

    expect(screen.getByText('Full server administration')).toBeInTheDocument();
    for (const rawKey of RAW_PERMISSION_KEYS) {
      expect(screen.queryByText(rawKey, { exact: false })).not.toBeInTheDocument();
    }
  });

  it('a group with no permissions renders a plain, honest empty state, never an empty raw dump', () => {
    const state = createVoiceState({
      myPermissions: ['authorization.groups.manage'],
      groups: [
        createGroupSummary({
          groupId: 'g-empty',
          name: 'Empty',
          permissions: [],
          protectedGroup: false,
        }),
      ],
    });
    render(<GroupsSection state={state} actions={createVoiceActions()} />);
    expect(screen.getByText('No permissions')).toBeInTheDocument();
  });

  it('renders a full-length (64-char) group name without truncating it, even with no spaces to wrap at', () => {
    const longName = 'Y'.repeat(64);
    const state = createVoiceState({
      myPermissions: ['authorization.groups.manage'],
      groups: [
        createGroupSummary({
          groupId: 'g-long',
          name: longName,
          permissions: ['voice.channel.join'],
          protectedGroup: false,
        }),
      ],
    });
    render(<GroupsSection state={state} actions={createVoiceActions()} />);
    // Full text present, never CSS/JS-truncated — `.groupSummary`'s `overflow-wrap: anywhere`
    // handles the visual wrapping a real browser layout engine would do (not observable in jsdom).
    expect(screen.getByText(longName)).toBeInTheDocument();
  });

  it('T13.2.1 QA — every create-group checkbox has the human label as its accessible name, never the raw key', () => {
    const state = createVoiceState({ myPermissions: ['authorization.groups.manage'], groups: [] });
    render(<GroupsSection state={state} actions={createVoiceActions()} />);

    // `getByLabelText` only succeeds when Testing Library's accessible-name computation actually
    // resolves the checkbox to this exact text — i.e. the wrapping `<label>` pattern really works,
    // not merely that the text is present somewhere nearby in the DOM.
    const kickCheckbox = screen.getByLabelText('Kick participants');
    expect(kickCheckbox).toBeInstanceOf(HTMLInputElement);
    expect((kickCheckbox as HTMLInputElement).type).toBe('checkbox');
    const tokensCheckbox = screen.getByLabelText('Manage invite and privilege tokens');
    expect((tokensCheckbox as HTMLInputElement).type).toBe('checkbox');
  });

  it('the create-group checkboxes are categorized and still submit the real PermissionKey wire value', () => {
    const createGroup = vi.fn();
    const state = createVoiceState({ myPermissions: ['authorization.groups.manage'], groups: [] });
    render(<GroupsSection state={state} actions={createVoiceActions({ createGroup })} />);

    // Category headings are present.
    expect(screen.getByText('Moderation')).toBeInTheDocument();
    expect(screen.getByText('Server Management')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue(''), { target: { value: 'New Group' } });
    fireEvent.click(screen.getByText('Kick participants'));
    fireEvent.click(screen.getByText('Ban participants'));
    fireEvent.click(screen.getByText('Create Group'));

    expect(createGroup).toHaveBeenCalledWith(
      'New Group',
      expect.arrayContaining(['moderation.kick', 'moderation.ban']),
    );
    const [, submittedPermissions] = createGroup.mock.calls[0] as [string, readonly string[]];
    expect(submittedPermissions).not.toContain('Kick participants');
    expect(submittedPermissions).not.toContain('Ban participants');
  });
});
