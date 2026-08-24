// @vitest-environment jsdom
//
// T13.4 — the speaking ring (a green outline layered over the avatar, never replacing anything) and
// the "User Volume"/"Mute for Me" entry point on `ParticipantRow.tsx`.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ParticipantRow } from '../../../apps/desktop/src/renderer/workspace/ParticipantRow.js';
import { createParticipant } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

function renderRow(overrides: Partial<Parameters<typeof ParticipantRow>[0]> = {}) {
  const onOpenVoiceControls = vi.fn();
  const props: Parameters<typeof ParticipantRow>[0] = {
    participant: createParticipant(),
    isSelf: false,
    hasCamera: false,
    hasScreen: false,
    isSpeaking: false,
    avatarCache: new Map(),
    onRequestAvatar: vi.fn(),
    ...overrides,
  };
  const result = render(<ParticipantRow {...props} />);
  return { ...result, onOpenVoiceControls };
}

describe('ParticipantRow (T13.4)', () => {
  it('shows the speaking ring only when isSpeaking is true (real data only, never fabricated)', () => {
    renderRow({ isSpeaking: false });
    const wrap = screen.getByTestId('participant-row-avatar-wrap-participant-1');
    expect(wrap).toHaveAttribute('data-speaking', 'false');
    cleanup();

    renderRow({ isSpeaking: true });
    const speakingWrap = screen.getByTestId('participant-row-avatar-wrap-participant-1');
    expect(speakingWrap).toHaveAttribute('data-speaking', 'true');
  });

  it('renders the "User Volume" entry point only when onOpenVoiceControls is provided (never for self)', () => {
    renderRow({ onOpenVoiceControls: undefined });
    expect(
      screen.queryByTestId('participant-row-voice-controls-participant-1'),
    ).not.toBeInTheDocument();
    cleanup();

    const onOpenVoiceControls = vi.fn();
    renderRow({ onOpenVoiceControls });
    const button = screen.getByTestId('participant-row-voice-controls-participant-1');
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onOpenVoiceControls).toHaveBeenCalledTimes(1);
  });

  it('the entry point is clearly distinct wording from the self-mute button (never "Mute microphone")', () => {
    renderRow({ onOpenVoiceControls: vi.fn() });
    const button = screen.getByTestId('participant-row-voice-controls-participant-1');
    expect(button.getAttribute('aria-label')).toMatch(/Adjust volume for/);
    expect(button.getAttribute('aria-label')).not.toMatch(/Mute microphone/);
  });
});

// T13.4 (UI consistency follow-up) — the voice-channel row must render the exact same T13.3
// server-local avatar Member Panel already shows, via the shared `UserAvatar` component, never the
// plain initials-only `Avatar` primitive it used before this fix.
describe('ParticipantRow — avatar (T13.4 UI consistency follow-up)', () => {
  const avatarRef = { revision: 1, hash: 'a'.repeat(64) };

  it('renders the real avatar image when avatarRef is cached', () => {
    const { container } = renderRow({
      participant: createParticipant({ avatarRef, memberRef: 'member-1' }),
      avatarCache: new Map([[avatarRef.hash, 'data:image/png;base64,fake']]),
    });
    // `Avatar.tsx` renders `<img alt="">`, which ARIA maps to `role="presentation"`, not `role="img"`
    // — queried by tag, not role, for exactly that reason.
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,fake');
  });

  it('falls back to initials when no avatarRef is set', () => {
    const { container } = renderRow({ participant: createParticipant({ avatarRef: undefined }) });
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument(); // "Alice" (the fixture's displayName)
  });

  it('updates live when avatarRef/avatarCache change on rerender — no rejoin required', () => {
    const avatarA = { revision: 1, hash: 'a'.repeat(64) };
    const avatarB = { revision: 2, hash: 'b'.repeat(64) };
    const { rerender, container } = renderRow({
      participant: createParticipant({ avatarRef: avatarA, memberRef: 'member-1' }),
      avatarCache: new Map([[avatarA.hash, 'data:image/png;base64,first']]),
    });
    expect(container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,first');

    rerender(
      <ParticipantRow
        participant={createParticipant({ avatarRef: avatarB, memberRef: 'member-1' })}
        isSelf={false}
        hasCamera={false}
        hasScreen={false}
        isSpeaking={false}
        avatarCache={new Map([[avatarB.hash, 'data:image/png;base64,second']])}
        onRequestAvatar={vi.fn()}
      />,
    );
    expect(container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,second');
  });

  it('removal (avatarRef cleared) returns live to the initials fallback — no stale image', () => {
    const { rerender, container } = renderRow({
      participant: createParticipant({ avatarRef, memberRef: 'member-1' }),
      avatarCache: new Map([[avatarRef.hash, 'data:image/png;base64,fake']]),
    });
    expect(container.querySelector('img')).toBeInTheDocument();

    rerender(
      <ParticipantRow
        participant={createParticipant({ avatarRef: undefined })}
        isSelf={false}
        hasCamera={false}
        hasScreen={false}
        isSpeaking={false}
        avatarCache={new Map()}
        onRequestAvatar={vi.fn()}
      />,
    );
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it("the local user's own row also renders their real current avatar", () => {
    const { container } = renderRow({
      participant: createParticipant({ avatarRef, displayName: 'Rodrigo' }),
      isSelf: true,
      avatarCache: new Map([[avatarRef.hash, 'data:image/png;base64,self']]),
    });
    expect(container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,self');
  });

  it('requests the avatar at most once for a not-yet-cached hash', () => {
    const onRequestAvatar = vi.fn();
    renderRow({
      participant: createParticipant({ avatarRef, memberRef: 'member-1' }),
      avatarCache: new Map(),
      onRequestAvatar,
    });
    expect(onRequestAvatar).toHaveBeenCalledTimes(1);
  });
});
