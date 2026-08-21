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
});
