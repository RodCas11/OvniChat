// @vitest-environment jsdom
//
// T13.1.1 QA: `Modal.tsx` gained a new `size="xlarge"` variant (for the redesigned `SettingsPanel`).
// No test for this shared primitive existed before T13.1.1 — this file covers the size variant plus
// the existing Escape/backdrop-close/focus-trap behavior it must remain size-agnostic for.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Modal } from '../../../apps/desktop/src/renderer/ui/Modal.js';
import modalStyles from '../../../apps/desktop/src/renderer/ui/Modal.module.css';

afterEach(() => {
  cleanup();
});

function renderModal(overrides: Partial<Parameters<typeof Modal>[0]> = {}) {
  const onClose = vi.fn();
  const props: Parameters<typeof Modal>[0] = {
    open: true,
    onClose,
    title: 'Test dialog',
    children: (
      <>
        <button type="button">First</button>
        <button type="button">Second</button>
      </>
    ),
    testId: 'test-modal',
    ...overrides,
  };
  const result = render(<Modal {...props} />);
  return { ...result, onClose };
}

describe('Modal (T13.1.1 — new size="xlarge" variant)', () => {
  it('applies a distinct class for size="xlarge", separate from the default "medium"', () => {
    renderModal({ size: 'xlarge' });
    const dialog = screen.getByTestId('test-modal');
    expect(dialog.className).toContain(modalStyles.xlarge);
    expect(dialog.className).not.toContain(modalStyles.medium);
  });

  it('renders nothing when closed, regardless of size', () => {
    renderModal({ open: false, size: 'xlarge' });
    expect(screen.queryByTestId('test-modal')).not.toBeInTheDocument();
  });

  it('is a real dialog with an accessible name from the title, for size="xlarge" same as any other size', () => {
    renderModal({ size: 'xlarge', title: 'Settings' });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  describe('behavior is size-agnostic (verified with size="xlarge")', () => {
    it('closes on Escape', () => {
      const { onClose } = renderModal({ size: 'xlarge' });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on a genuine backdrop click (mousedown lands directly on the backdrop)', () => {
      const { onClose } = renderModal({ size: 'xlarge' });
      const dialog = screen.getByTestId('test-modal');
      const backdrop = dialog.parentElement;
      expect(backdrop).not.toBeNull();

      fireEvent.mouseDown(backdrop as Element);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does NOT close when the mousedown lands on the dialog itself', () => {
      const { onClose } = renderModal({ size: 'xlarge' });
      const dialog = screen.getByTestId('test-modal');

      fireEvent.mouseDown(dialog);

      expect(onClose).not.toHaveBeenCalled();
    });

    // The dialog's own header (containing the Close button) precedes `children` (the body) in DOM
    // order, so the real first/last focusable elements inside the dialog are [Close, First, Second]
    // — not [First, Second] alone. This is real, unsurprising DOM order, not a bug in the trap.
    it('moves initial focus to the first focusable element inside the dialog (the header Close button, which precedes the body content)', () => {
      renderModal({ size: 'xlarge' });
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });

    it('wraps focus from the last focusable element back to the first (Close) on Tab', () => {
      renderModal({ size: 'xlarge' });
      const closeButton = screen.getByRole('button', { name: 'Close' });
      const last = screen.getByRole('button', { name: 'Second' });

      last.focus();
      expect(last).toHaveFocus();
      fireEvent.keyDown(document, { key: 'Tab' });

      expect(closeButton).toHaveFocus();
    });

    it('wraps focus from the first focusable element (Close) to the last on Shift+Tab', () => {
      renderModal({ size: 'xlarge' });
      const closeButton = screen.getByRole('button', { name: 'Close' });
      const last = screen.getByRole('button', { name: 'Second' });

      closeButton.focus();
      expect(closeButton).toHaveFocus();
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

      expect(last).toHaveFocus();
    });

    it('returns focus to whatever triggered the dialog once it closes', () => {
      const trigger = document.createElement('button');
      trigger.textContent = 'Open';
      document.body.appendChild(trigger);
      trigger.focus();
      expect(trigger).toHaveFocus();

      const { rerender } = render(
        <Modal open onClose={vi.fn()} title="Test dialog" testId="test-modal" size="xlarge">
          <button type="button">First</button>
        </Modal>,
      );
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

      rerender(
        <Modal open={false} onClose={vi.fn()} title="Test dialog" testId="test-modal" size="xlarge">
          <button type="button">First</button>
        </Modal>,
      );

      expect(trigger).toHaveFocus();
      document.body.removeChild(trigger);
    });
  });
});
