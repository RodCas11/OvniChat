// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MemberPanel } from '../../../apps/desktop/src/renderer/workspace/MemberPanel.js';
import { createParticipant } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('MemberPanel (T13.1)', () => {
  it('header text reads exactly "Members — {count}"', () => {
    render(
      <MemberPanel
        inChannel
        participants={[
          createParticipant(),
          createParticipant({ participantId: 'p2', displayName: 'Bob' }),
        ]}
        selfParticipantId={undefined}
      />,
    );

    expect(screen.getByTestId('member-panel-title')).toHaveTextContent('Members — 2');
  });

  it('header text reads "Members — 0" with nobody present', () => {
    render(<MemberPanel inChannel participants={[]} selfParticipantId={undefined} />);
    expect(screen.getByTestId('member-panel-title')).toHaveTextContent('Members — 0');
  });

  it('shows a not-in-channel empty state, never fabricated members, when not joined', () => {
    render(<MemberPanel inChannel={false} participants={[]} selfParticipantId={undefined} />);
    expect(screen.getByText('Not in a voice channel')).toBeInTheDocument();
  });

  it('collapsing hides the roster and shows only the expand toggle; expanding restores it', () => {
    render(
      <MemberPanel inChannel participants={[createParticipant()]} selfParticipantId={undefined} />,
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
    render(
      <MemberPanel inChannel participants={[createParticipant()]} selfParticipantId={undefined} />,
    );
    expect(screen.getByTestId('member-panel-collapse-toggle')).toHaveAccessibleName();
  });

  describe('T13.1.1 dedup fix — the default fallback group must not repeat the header count', () => {
    it('the default fallback single "Members" group renders no second "Members — N" label below the header', () => {
      render(
        <MemberPanel
          inChannel
          participants={[
            createParticipant(),
            createParticipant({ participantId: 'p2', displayName: 'Bob' }),
          ]}
          selfParticipantId={undefined}
        />,
      );

      expect(screen.getByTestId('member-panel-title')).toHaveTextContent('Members — 2');
      // Exactly one occurrence of the count text anywhere in the rendered output — the fallback
      // group's own label must not duplicate the header immediately above it.
      expect(screen.getAllByText('Members — 2')).toHaveLength(1);
    });

    it("a real, distinctly-labeled `groups` prop DOES render each group's own label (future T13.3 real-role-grouping case)", () => {
      const alice = createParticipant();
      const bob = createParticipant({ participantId: 'p2', displayName: 'Bob' });

      render(
        <MemberPanel
          inChannel
          participants={[alice, bob]}
          selfParticipantId={undefined}
          groups={[
            { label: 'Officers', members: [alice] },
            { label: 'Guests', members: [bob] },
          ]}
        />,
      );

      expect(screen.getByTestId('member-panel-title')).toHaveTextContent('Members — 2');
      expect(screen.getByText('Officers — 1')).toBeInTheDocument();
      expect(screen.getByText('Guests — 1')).toBeInTheDocument();
      // The header's own "Members — 2" text is still exactly once — the multi-group case does not
      // reintroduce the duplicate either, it just adds real, distinct per-group labels beside it.
      expect(screen.getAllByText('Members — 2')).toHaveLength(1);
    });

    it('a single-entry `groups` prop still renders that one real label (the dedup fix only suppresses the *fabricated fallback* label, never a real one)', () => {
      const alice = createParticipant();

      render(
        <MemberPanel
          inChannel
          participants={[alice]}
          selfParticipantId={undefined}
          groups={[{ label: 'Members', members: [alice] }]}
        />,
      );

      expect(screen.getByTestId('member-panel-title')).toHaveTextContent('Members — 1');
      // Here a real "Members — 1" label legitimately appears twice (header + the one real,
      // explicitly-supplied group) — this is the honest distinguishing case the fix relies on.
      expect(screen.getAllByText('Members — 1')).toHaveLength(2);
    });
  });
});
