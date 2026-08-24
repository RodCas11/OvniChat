// @vitest-environment jsdom
//
// T13.5 — the media stage: chat-primary default, adaptive camera grid, camera-off avatar fallback,
// speaking-ring integration, screen-focused layout (with a camera filmstrip alongside), focus/
// return-to-grid, and multiple-screen-share representation. Every scenario here uses `MediaStage`
// directly (never `MainContent`, which only decides layout shape) so these tests exercise the real
// production component tree, not a mock.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MediaStage } from '../../../apps/desktop/src/renderer/workspace/MediaStage.js';
import {
  createParticipant,
  createVoiceActions,
  createVoiceState,
} from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

function fakeStream(): MediaStream {
  return {} as unknown as MediaStream;
}

describe('MediaStage (T13.5)', () => {
  it('renders nothing when no camera/screen stream is active — chat stays primary (Section 18/80)', () => {
    const alice = createParticipant();
    const { container } = render(
      <MediaStage
        state={createVoiceState({ participants: [alice] })}
        actions={createVoiceActions()}
        participants={[alice]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('camera-off participants render as a real avatar tile, never a black rectangle, alongside anyone with real video', () => {
    const alice = createParticipant({ participantId: 'p1', displayName: 'Alice' });
    const bob = createParticipant({ participantId: 'p2', displayName: 'Bob' });
    render(
      <MediaStage
        state={createVoiceState({
          participants: [alice, bob],
          remoteCameraStreams: new Map([['p1', fakeStream()]]),
        })}
        actions={createVoiceActions()}
        participants={[alice, bob]}
      />,
    );

    expect(screen.getByTestId('media-stage-grid')).toBeInTheDocument();
    const aliceTile = screen.getByTestId('media-stage-camera-p1');
    expect(aliceTile.querySelector('video')).toBeInTheDocument();
    expect(
      aliceTile.querySelector('[data-role="media-tile-avatar-fallback"]'),
    ).not.toBeInTheDocument();
    const bobTile = screen.getByTestId('media-stage-camera-p2');
    expect(bobTile.querySelector('[data-role="media-tile-avatar-fallback"]')).toBeInTheDocument();
    expect(bobTile.querySelector('video')).not.toBeInTheDocument();
  });

  it('the speaking ring appears on both a real-video tile and a camera-off avatar-fallback tile', () => {
    const alice = createParticipant({ participantId: 'p1', displayName: 'Alice' });
    const bob = createParticipant({ participantId: 'p2', displayName: 'Bob' });
    render(
      <MediaStage
        state={createVoiceState({
          participants: [alice, bob],
          remoteCameraStreams: new Map([['p1', fakeStream()]]),
          speakingParticipantIds: new Set(['p1', 'p2']),
        })}
        actions={createVoiceActions()}
        participants={[alice, bob]}
      />,
    );

    expect(screen.getByTestId('media-stage-camera-p1')).toHaveAttribute('data-speaking', 'true');
    expect(screen.getByTestId('media-stage-camera-p2')).toHaveAttribute('data-speaking', 'true');
  });

  it('a screen share becomes the primary content, with active cameras shown in a filmstrip alongside it', () => {
    const alice = createParticipant({ participantId: 'p1', displayName: 'Alice' });
    render(
      <MediaStage
        state={createVoiceState({
          participants: [alice],
          remoteScreenStreams: new Map([['p1', fakeStream()]]),
          remoteCameraStreams: new Map([['p1', fakeStream()]]),
        })}
        actions={createVoiceActions()}
        participants={[alice]}
      />,
    );

    expect(screen.getByTestId('media-stage-screen-p1')).toBeInTheDocument();
    expect(screen.getByText('Alice’s screen')).toBeInTheDocument();
    // Alice's camera also shows, in the filmstrip, alongside her primary screen (Section 38).
    expect(screen.getAllByTestId('media-stage-camera-p1').length).toBeGreaterThan(0);
  });

  it('multiple simultaneous screen shares are represented deliberately, with a switcher to change focus', () => {
    const alice = createParticipant({ participantId: 'p1', displayName: 'Alice' });
    const bob = createParticipant({ participantId: 'p2', displayName: 'Bob' });
    render(
      <MediaStage
        state={createVoiceState({
          participants: [alice, bob],
          remoteScreenStreams: new Map([
            ['p1', fakeStream()],
            ['p2', fakeStream()],
          ]),
        })}
        actions={createVoiceActions()}
        participants={[alice, bob]}
      />,
    );

    expect(screen.getByRole('tablist', { name: 'Screen shares' })).toBeInTheDocument();
    expect(screen.getByTestId('media-stage-screen-switch-p1')).toBeInTheDocument();
    expect(screen.getByTestId('media-stage-screen-switch-p2')).toBeInTheDocument();
    expect(screen.getByTestId('media-stage-screen-p1')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('media-stage-screen-switch-p2'));

    expect(screen.getByTestId('media-stage-screen-p2')).toBeInTheDocument();
    expect(screen.queryByTestId('media-stage-screen-p1')).not.toBeInTheDocument();
  });

  it('clicking a camera tile focuses it; "Back to grid" returns to the adaptive grid', () => {
    const alice = createParticipant({ participantId: 'p1', displayName: 'Alice' });
    const bob = createParticipant({ participantId: 'p2', displayName: 'Bob' });
    render(
      <MediaStage
        state={createVoiceState({
          participants: [alice, bob],
          remoteCameraStreams: new Map([
            ['p1', fakeStream()],
            ['p2', fakeStream()],
          ]),
        })}
        actions={createVoiceActions()}
        participants={[alice, bob]}
      />,
    );

    expect(screen.getByTestId('media-stage-grid')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Focus Alice' }));

    expect(screen.queryByTestId('media-stage-grid')).not.toBeInTheDocument();
    expect(screen.getByTestId('media-stage-focused-camera')).toBeInTheDocument();
    expect(screen.getByTestId('media-stage-back-to-grid')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('media-stage-back-to-grid'));

    expect(screen.getByTestId('media-stage-grid')).toBeInTheDocument();
  });

  it('a stream-ended focus target (track ended / participant left) falls back cleanly — no frozen/stale tile', () => {
    const alice = createParticipant({ participantId: 'p1', displayName: 'Alice' });
    const bob = createParticipant({ participantId: 'p2', displayName: 'Bob' });
    const { rerender } = render(
      <MediaStage
        state={createVoiceState({
          participants: [alice, bob],
          remoteScreenStreams: new Map([['p1', fakeStream()]]),
        })}
        actions={createVoiceActions()}
        participants={[alice, bob]}
      />,
    );
    expect(screen.getByTestId('media-stage-screen-p1')).toBeInTheDocument();

    // Alice's screen share ends; Bob now shares instead.
    rerender(
      <MediaStage
        state={createVoiceState({
          participants: [alice, bob],
          remoteScreenStreams: new Map([['p2', fakeStream()]]),
        })}
        actions={createVoiceActions()}
        participants={[alice, bob]}
      />,
    );

    expect(screen.queryByTestId('media-stage-screen-p1')).not.toBeInTheDocument();
    expect(screen.getByTestId('media-stage-screen-p2')).toBeInTheDocument();
  });

  it("requests a camera-off tile's avatar via the real memberRef-based action, never a duplicate resolver", () => {
    const requestAvatar = vi.fn();
    const avatarRef = { revision: 1, hash: 'a'.repeat(64) };
    const bob = createParticipant({
      participantId: 'p2',
      displayName: 'Bob',
      memberRef: 'member-2',
      avatarRef,
    });
    const alice = createParticipant({ participantId: 'p1', displayName: 'Alice' });
    render(
      <MediaStage
        state={createVoiceState({
          participants: [alice, bob],
          // Alice actually streams (so the grid renders at all — Section 80); Bob has no camera, so
          // his tile is the avatar fallback whose `onRequestAvatar` this test is proving.
          remoteCameraStreams: new Map([['p1', fakeStream()]]),
        })}
        actions={createVoiceActions({ requestAvatar })}
        participants={[alice, bob]}
      />,
    );

    expect(requestAvatar).toHaveBeenCalledWith('member', 'member-2');
  });
});
