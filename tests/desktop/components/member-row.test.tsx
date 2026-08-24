// @vitest-environment jsdom
//
// T13.4 (UI consistency follow-up) — `MemberRow` renders the same shared speaking-ring treatment
// `ParticipantRow` already has (via `UserAvatar`'s own `speaking` prop), driven entirely by the
// `isSpeaking` value the caller (`VoiceChannelView.tsx`'s `memberPanelEntries`) already resolved —
// this component never computes speaking state itself.
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemberRow } from '../../../apps/desktop/src/renderer/workspace/MemberRow.js';
import { createMemberPanelEntry } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

function renderRow(overrides: Partial<Parameters<typeof MemberRow>[0]> = {}) {
  const props: Parameters<typeof MemberRow>[0] = {
    member: createMemberPanelEntry(),
    avatarCache: new Map(),
    onRequestAvatar: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  return render(<MemberRow {...props} />);
}

describe('MemberRow — speaking indicator (T13.4 UI consistency follow-up)', () => {
  it('shows no speaking state for an ordinary, not-speaking member', () => {
    renderRow({ member: createMemberPanelEntry({ isSpeaking: false }) });
    const wrap = screen.getByTestId('member-row-avatar-wrap-member-1');
    expect(wrap).toHaveAttribute('data-speaking', 'false');
  });

  it('shows the same green speaking state ParticipantRow uses when the member is currently speaking', () => {
    renderRow({ member: createMemberPanelEntry({ isSpeaking: true }) });
    const wrap = screen.getByTestId('member-row-avatar-wrap-member-1');
    expect(wrap).toHaveAttribute('data-speaking', 'true');
  });

  it('clears live when the caller re-resolves isSpeaking to false (silence transition, no separate delay here)', () => {
    const { rerender } = renderRow({ member: createMemberPanelEntry({ isSpeaking: true }) });
    expect(screen.getByTestId('member-row-avatar-wrap-member-1')).toHaveAttribute(
      'data-speaking',
      'true',
    );

    rerender(
      <MemberRow
        member={createMemberPanelEntry({ isSpeaking: false })}
        avatarCache={new Map()}
        onRequestAvatar={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId('member-row-avatar-wrap-member-1')).toHaveAttribute(
      'data-speaking',
      'false',
    );
  });

  it('two independently-rendered speaking members both show the indicator (no artificial single-speaker limit)', () => {
    renderRow({ member: createMemberPanelEntry({ key: 'a', isSpeaking: true }) });
    renderRow({ member: createMemberPanelEntry({ key: 'b', isSpeaking: true }) });
    expect(screen.getByTestId('member-row-avatar-wrap-a')).toHaveAttribute('data-speaking', 'true');
    expect(screen.getByTestId('member-row-avatar-wrap-b')).toHaveAttribute('data-speaking', 'true');
  });

  it('an offline/left member never carries a stale speaking indicator — the caller always resolves isSpeaking fresh, never a cached true', () => {
    // Simulates the caller's own re-resolution after a voice leave/server switch/reconnect: a
    // previously-speaking member's row must render exactly what the caller currently passes, never
    // anything remembered internally by this presentation-only component.
    renderRow({ member: createMemberPanelEntry({ isSpeaking: false }) });
    expect(screen.getByTestId('member-row-avatar-wrap-member-1')).toHaveAttribute(
      'data-speaking',
      'false',
    );
  });
});
