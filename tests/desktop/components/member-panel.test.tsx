// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemberPanel } from '../../../apps/desktop/src/renderer/workspace/MemberPanel.js';
import { createMemberPanelEntry } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('MemberPanel (T13.1, widened T13.3 to server-wide presence)', () => {
  it('header text reads exactly "Members — {count}"', () => {
    const alice = createMemberPanelEntry();
    const bob = createMemberPanelEntry({ key: 'p2', displayName: 'Bob' });
    render(
      <MemberPanel
        connected
        groups={[{ label: 'Members', members: [alice, bob] }]}
        hasRealGroups={false}
        totalCount={2}
        avatarCache={new Map()}
        onRequestAvatar={vi.fn()}
        onSelectMember={vi.fn()}
      />,
    );

    expect(screen.getByTestId('member-panel-title')).toHaveTextContent('Members — 2');
  });

  it('header text reads "Members — 0" with nobody present', () => {
    render(
      <MemberPanel
        connected
        groups={[]}
        hasRealGroups={false}
        totalCount={0}
        avatarCache={new Map()}
        onRequestAvatar={vi.fn()}
        onSelectMember={vi.fn()}
      />,
    );
    expect(screen.getByTestId('member-panel-title')).toHaveTextContent('Members — 0');
  });

  it('shows a not-connected empty state, never fabricated members, when not connected', () => {
    render(
      <MemberPanel
        connected={false}
        groups={[]}
        hasRealGroups={false}
        totalCount={0}
        avatarCache={new Map()}
        onRequestAvatar={vi.fn()}
        onSelectMember={vi.fn()}
      />,
    );
    expect(screen.getByText('Not connected')).toBeInTheDocument();
  });

  it('collapsing hides the roster and shows only the expand toggle; expanding restores it', () => {
    const alice = createMemberPanelEntry();
    render(
      <MemberPanel
        connected
        groups={[{ label: 'Members', members: [alice] }]}
        hasRealGroups={false}
        totalCount={1}
        avatarCache={new Map()}
        onRequestAvatar={vi.fn()}
        onSelectMember={vi.fn()}
      />,
    );

    expect(screen.getByTestId('member-panel')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('member-panel-collapse-toggle'));

    expect(screen.queryByTestId('member-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    const expandToggle = screen.getByTestId('member-panel-expand-toggle');
    expect(expandToggle).toBeInTheDocument();

    fireEvent.click(expandToggle);

    expect(screen.getByTestId('member-panel')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('every icon-only toggle has a real accessible name', () => {
    const alice = createMemberPanelEntry();
    render(
      <MemberPanel
        connected
        groups={[{ label: 'Members', members: [alice] }]}
        hasRealGroups={false}
        totalCount={1}
        avatarCache={new Map()}
        onRequestAvatar={vi.fn()}
        onSelectMember={vi.fn()}
      />,
    );
    expect(screen.getByTestId('member-panel-collapse-toggle')).toHaveAccessibleName();
  });

  it('clicking a member row calls onSelectMember with that real entry', () => {
    const alice = createMemberPanelEntry();
    const onSelectMember = vi.fn();
    render(
      <MemberPanel
        connected
        groups={[{ label: 'Members', members: [alice] }]}
        hasRealGroups={false}
        totalCount={1}
        avatarCache={new Map()}
        onRequestAvatar={vi.fn()}
        onSelectMember={onSelectMember}
      />,
    );

    fireEvent.click(screen.getByTestId(`member-row-${alice.key}`));
    expect(onSelectMember).toHaveBeenCalledWith(alice);
  });

  describe('T13.1.1 dedup fix — the default fallback group must not repeat the header count', () => {
    it('the default fallback single "Members" group renders no second "Members — N" label below the header', () => {
      const alice = createMemberPanelEntry();
      const bob = createMemberPanelEntry({ key: 'p2', displayName: 'Bob' });
      render(
        <MemberPanel
          connected
          groups={[{ label: 'Members', members: [alice, bob] }]}
          hasRealGroups={false}
          totalCount={2}
          avatarCache={new Map()}
          onRequestAvatar={vi.fn()}
          onSelectMember={vi.fn()}
        />,
      );

      expect(screen.getByTestId('member-panel-title')).toHaveTextContent('Members — 2');
      // Exactly one occurrence of the count text anywhere in the rendered output — the fallback
      // group's own label must not duplicate the header immediately above it.
      expect(screen.getAllByText('Members — 2')).toHaveLength(1);
    });

    it("real role-bucket groups (`hasRealGroups: true`) DO render each group's own label", () => {
      const alice = createMemberPanelEntry({ roleBucket: 'admin' });
      const bob = createMemberPanelEntry({ key: 'p2', displayName: 'Bob' });

      render(
        <MemberPanel
          connected
          groups={[
            { label: 'Admins', members: [alice] },
            { label: 'Members', members: [bob] },
          ]}
          hasRealGroups
          totalCount={2}
          avatarCache={new Map()}
          onRequestAvatar={vi.fn()}
          onSelectMember={vi.fn()}
        />,
      );

      expect(screen.getByTestId('member-panel-title')).toHaveTextContent('Members — 2');
      expect(screen.getByText('Admins — 1')).toBeInTheDocument();
      expect(screen.getByText('Members — 1')).toBeInTheDocument();
      // The header's own "Members — 2" text is still exactly once.
      expect(screen.getAllByText('Members — 2')).toHaveLength(1);
    });

    it('a single-entry real group still renders that one real label (the dedup fix only suppresses the *fabricated fallback* label, never a real one)', () => {
      const alice = createMemberPanelEntry({ roleBucket: 'admin' });

      render(
        <MemberPanel
          connected
          groups={[{ label: 'Admins', members: [alice] }]}
          hasRealGroups
          totalCount={1}
          avatarCache={new Map()}
          onRequestAvatar={vi.fn()}
          onSelectMember={vi.fn()}
        />,
      );

      expect(screen.getByTestId('member-panel-title')).toHaveTextContent('Members — 1');
      expect(screen.getByText('Admins — 1')).toBeInTheDocument();
    });
  });
});
