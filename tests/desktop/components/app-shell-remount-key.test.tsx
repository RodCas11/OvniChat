// @vitest-environment jsdom
//
// T13.1 — `App.tsx` mounts `<AppShell key={\`${connection.config.url}#${connectionSequenceRef.current}\`} .../>`
// specifically so React always fully unmounts/remounts the connected-workspace root on every
// connection sequence, even a same-URL reconnect (see `App.tsx`'s and `AppShell.tsx`'s own doc
// comments for the full React-19-batching rationale). Exercising the *real* `AppShell` here would
// require mocking the entire `useVoiceChannel` realtime/WebRTC stack it owns, which belongs to this
// repo's existing two-client realtime/WebRTC test layers, not a component test. This instead proves
// the exact `key` mechanism `App.tsx` relies on, using a minimal harness with the same shape
// (a `key` derived from `url#sequence`) and a stateful child standing in for `VoiceChannelView`'s
// own local UI state (e.g. `selectedChatTarget`) — a real, table-driven proof that:
//   1. an unchanged key across a re-render preserves local child state (the React behavior a naive
//      `key={url}` alone would rely on for a *different*-URL switch, but which fails for a
//      same-URL-but-different-sequence switch — this is exactly the gap `connectionSequenceRef`
//      closes);
//   2. a changed key always discards local child state and re-initializes it fresh, regardless of
//      whether the URL portion of the key changed at all.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

/** Stands in for `VoiceChannelView`'s own local, presentation-only UI state (e.g.
 * `selectedChatTarget`) — a plain `useState` that starts at a fixed initial value and can be
 * mutated by the test, exactly like a user selecting a different channel's chat would. */
function StatefulWorkspaceStandIn({ label }: { readonly label: string }): ReactElement {
  const [selection, setSelection] = useState('server');
  return (
    <div>
      <span data-testid="workspace-label">{label}</span>
      <span data-testid="workspace-selection">{selection}</span>
      <button
        type="button"
        onClick={() => {
          setSelection('channel:general');
        }}
      >
        Select a channel
      </button>
    </div>
  );
}

function Harness({ appShellKey, url }: { readonly appShellKey: string; readonly url: string }) {
  return (
    <div key={appShellKey}>
      <StatefulWorkspaceStandIn label={url} />
    </div>
  );
}

afterEach(() => {
  cleanup();
});

describe('AppShell remount-key mechanism (T13.1)', () => {
  it('an unchanged key preserves local workspace state across a re-render (the naive-key gap)', () => {
    const { rerender } = render(<Harness appShellKey="ws://a:1#1" url="ws://a:1" />);
    fireEvent.click(screen.getByText('Select a channel'));
    expect(screen.getByTestId('workspace-selection')).toHaveTextContent('channel:general');

    // Re-rendering with the SAME key (e.g. a same-URL "switch" that a naive `key={url}` alone would
    // produce) does NOT reset local state — demonstrating exactly why `connectionSequenceRef` must
    // also be part of the real key.
    rerender(<Harness appShellKey="ws://a:1#1" url="ws://a:1" />);
    expect(screen.getByTestId('workspace-selection')).toHaveTextContent('channel:general');
  });

  it('a changed key (matching connectionSequenceRef bumping on every connectTo) always resets local workspace state, even for the same URL', () => {
    const { rerender } = render(<Harness appShellKey="ws://a:1#1" url="ws://a:1" />);
    fireEvent.click(screen.getByText('Select a channel'));
    expect(screen.getByTestId('workspace-selection')).toHaveTextContent('channel:general');

    // Same URL, but a new connection sequence (mirrors reconnecting to the exact same bookmark) —
    // the key changes, so React must fully discard the old instance's state.
    rerender(<Harness appShellKey="ws://a:1#2" url="ws://a:1" />);
    expect(screen.getByTestId('workspace-selection')).toHaveTextContent('server');
  });

  it('a changed key for a genuinely different server also resets local workspace state (no stale channel selection leaks across servers)', () => {
    const { rerender } = render(<Harness appShellKey="ws://a:1#1" url="ws://a:1" />);
    fireEvent.click(screen.getByText('Select a channel'));
    expect(screen.getByTestId('workspace-selection')).toHaveTextContent('channel:general');

    rerender(<Harness appShellKey="ws://b:1#2" url="ws://b:1" />);
    expect(screen.getByTestId('workspace-label')).toHaveTextContent('ws://b:1');
    expect(screen.getByTestId('workspace-selection')).toHaveTextContent('server');
  });
});
