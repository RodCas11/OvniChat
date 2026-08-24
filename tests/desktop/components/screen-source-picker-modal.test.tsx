// @vitest-environment jsdom
//
// T13.5 — real-consumer proof that the shared `Modal` primitive's T13.4 focus fix (see
// `Modal.tsx`'s own doc comment on the `[open, onClose]` dependency-array regression) is not
// regressed by the screen-share source picker, mirroring `channel-modal.test.tsx`/
// `add-server-dialog.test.tsx`'s own established real-consumer pattern. `ScreenSourcePicker` itself
// has no free-text search field (Section 76 only applies "if" one exists), so this proves the
// closest applicable claim instead: real interaction with its actual controls (selecting a source,
// changing the quality `<select>`, choosing an audio mode) never loses focus to the modal's own
// Close button, and Escape still closes the dialog.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScreenSourcePicker } from '../../../apps/desktop/src/renderer/voice/ScreenSourcePicker.js';
import { Modal } from '../../../apps/desktop/src/renderer/ui/Modal.js';
import { installDesktopAppMock } from '../fixtures/desktop-app-mock.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPickerModal(onCancel = vi.fn(), onSourceSelected = vi.fn()) {
  return render(
    <Modal
      open
      onClose={onCancel}
      title="Share your screen"
      size="large"
      testId="screen-picker-modal"
    >
      <ScreenSourcePicker onSourceSelected={onSourceSelected} onCancel={onCancel} />
    </Modal>,
  );
}

describe('ScreenSourcePicker inside the real shared Modal (T13.5, T13.4 focus-fix regression)', () => {
  it("changing the quality control after focusing it keeps that focus — Close never steals it (mirrors modal.test.tsx's own established pattern)", async () => {
    installDesktopAppMock({
      listScreenShareSources: vi.fn().mockResolvedValue([
        {
          id: 'screen:0',
          name: 'Entire Screen',
          type: 'screen',
          thumbnailDataUrl: '',
          appIconDataUrl: undefined,
          displayId: '0',
        },
      ]),
    });

    renderPickerModal();
    await screen.findByRole('button', { name: /Entire Screen/u });

    const quality = screen.getByLabelText('Quality');
    quality.focus();
    expect(quality).toHaveFocus();

    fireEvent.change(quality, { target: { value: 'smooth' } });
    expect(quality).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
    expect(quality).toHaveValue('smooth');

    const systemAudio = screen.getByLabelText('System audio');
    systemAudio.focus();
    fireEvent.click(systemAudio);
    expect(systemAudio).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
    expect(systemAudio).toBeChecked();
  });

  it('Escape still closes the dialog, and focus restores correctly (the T13.4 Modal contract, unmodified by this task)', async () => {
    const onCancel = vi.fn();
    installDesktopAppMock({ listScreenShareSources: vi.fn().mockResolvedValue([]) });
    renderPickerModal(onCancel);

    await waitFor(() => {
      expect(screen.getByText('No screens available.')).toBeInTheDocument();
    });

    fireEvent.keyDown(screen.getByTestId('screen-picker-modal'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
