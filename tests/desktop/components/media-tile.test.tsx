// @vitest-environment jsdom
//
// T13.5 — `MediaTile`: real video vs. real avatar fallback, the shared speaking ring, and the
// Picture-in-Picture entry point (Sections 22-25, 53-54).
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MediaTile } from '../../../apps/desktop/src/renderer/workspace/MediaTile.js';

afterEach(() => {
  cleanup();
});

function renderTile(overrides: Partial<Parameters<typeof MediaTile>[0]> = {}) {
  const props: Parameters<typeof MediaTile>[0] = {
    participantId: 'p1',
    displayName: 'Alice',
    avatarRef: undefined,
    avatarCache: new Map(),
    onRequestAvatar: vi.fn(),
    speaking: false,
    stream: undefined,
    kind: 'camera',
    ...overrides,
  };
  return render(<MediaTile {...props} />);
}

describe('MediaTile (T13.5)', () => {
  it('camera-off (no stream): renders a real avatar fallback, never a black rectangle or broken video', () => {
    renderTile({ stream: undefined });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('video')).not.toBeInTheDocument();
    expect(document.querySelector('[data-role="media-tile-avatar-fallback"]')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('camera on (real stream): renders real video, never the avatar fallback', () => {
    renderTile({ stream: {} as unknown as MediaStream });
    expect(document.querySelector('[data-role="media-tile-video-camera"]')).toBeInTheDocument();
    expect(
      document.querySelector('[data-role="media-tile-avatar-fallback"]'),
    ).not.toBeInTheDocument();
  });

  it('a screen tile labels itself as "<name>’s screen", never plain "<name>"', () => {
    renderTile({ kind: 'screen', stream: {} as unknown as MediaStream, displayName: 'Bob' });
    expect(screen.getByText('Bob’s screen')).toBeInTheDocument();
  });

  it('never exposes participantId/technical identifiers in visible text', () => {
    renderTile({
      participantId: 'internal-participant-id-123',
      stream: {} as unknown as MediaStream,
    });
    expect(screen.queryByText('internal-participant-id-123')).not.toBeInTheDocument();
  });

  it('the PiP entry point only appears when PiP is supported AND a real stream exists — never for a camera-off avatar tile', () => {
    const { rerender } = renderTile({ stream: undefined, pipSupported: true });
    expect(screen.queryByTestId('media-tile-pip-p1')).not.toBeInTheDocument();

    rerender(
      <MediaTile
        participantId="p1"
        displayName="Alice"
        avatarRef={undefined}
        avatarCache={new Map()}
        onRequestAvatar={vi.fn()}
        speaking={false}
        stream={{} as unknown as MediaStream}
        kind="camera"
        pipSupported={false}
      />,
    );
    expect(screen.queryByTestId('media-tile-pip-p1')).not.toBeInTheDocument();

    rerender(
      <MediaTile
        participantId="p1"
        displayName="Alice"
        avatarRef={undefined}
        avatarCache={new Map()}
        onRequestAvatar={vi.fn()}
        speaking={false}
        stream={{} as unknown as MediaStream}
        kind="camera"
        pipSupported
      />,
    );
    expect(screen.getByTestId('media-tile-pip-p1')).toBeInTheDocument();
  });

  it('clicking a tile with an onFocus handler calls it; a tile with no handler (e.g. already-focused) is not clickable', () => {
    const onFocus = vi.fn();
    renderTile({ stream: {} as unknown as MediaStream, onFocus });
    fireEvent.click(screen.getByRole('button', { name: 'Focus Alice' }));
    expect(onFocus).toHaveBeenCalledTimes(1);

    cleanup();
    renderTile({ stream: {} as unknown as MediaStream, onFocus: undefined });
    expect(screen.getByRole('button', { name: 'Alice' })).toBeDisabled();
  });
});
