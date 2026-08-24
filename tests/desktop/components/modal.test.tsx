// @vitest-environment jsdom
//
// T13.1.1 QA: `Modal.tsx` gained a new `size="xlarge"` variant (for the redesigned `SettingsPanel`).
// No test for this shared primitive existed before T13.1.1 — this file covers the size variant plus
// the existing Escape/backdrop-close/focus-trap behavior it must remain size-agnostic for.
//
// Post-T13.4 UX regression coverage: the "establish initial focus" effect used to depend on
// `[open, onClose]`. Every real consumer passes an inline `onClose` (a fresh function identity every
// render), and a controlled form input re-renders its owner on every keystroke — so typing anywhere
// in a modal form re-ran that effect on every keystroke even though `open` never changed, and it
// always resolved focus back to the first focusable element in DOM order (the header Close button),
// yanking focus out of the field the user was actively typing into. See `ControlledFormModal` below.
import { useState, type ReactElement } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Modal } from '../../../apps/desktop/src/renderer/ui/Modal.js';
import modalStyles from '../../../apps/desktop/src/renderer/ui/Modal.module.css';

afterEach(() => {
  cleanup();
});

/**
 * Mirrors the exact shape of a real consumer like `AddServerDialog`: a controlled text input whose
 * `onChange` updates local state (re-rendering this component on every keystroke), and an `onClose`
 * handler defined as a plain function in the component body — given a brand-new identity on every
 * one of those re-renders, exactly like `AddServerDialog`'s own `resetAndClose`.
 */
function ControlledFormModal({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const [value, setValue] = useState('');

  function handleClose(): void {
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="Form dialog" testId="form-modal">
      <input
        data-testid="form-input"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
    </Modal>
  );
}

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

describe('Modal — focus stability across re-renders (regression: onClose identity must never reset focus)', () => {
  it('prefers a child explicitly marked autoFocus over the default first-focusable (Close) fallback', () => {
    render(
      <Modal open onClose={vi.fn()} title="Test dialog" testId="test-modal">
        <input data-testid="autofocus-input" autoFocus />
        <button type="button">Second</button>
      </Modal>,
    );
    expect(screen.getByTestId('autofocus-input')).toHaveFocus();
  });

  // Mandatory regression test: open a modal containing a text input and Close button, focus the
  // input, type multiple characters one by one (each keystroke re-renders `ControlledFormModal` and
  // hands `Modal` a brand-new `onClose` identity, exactly like a real consumer), and assert the input
  // stays focused — and Close never becomes `document.activeElement` — after every single update.
  it('typing multiple characters one by one keeps the input focused and never moves focus to Close', () => {
    render(<ControlledFormModal open onClose={vi.fn()} />);
    const input = screen.getByTestId('form-input');
    input.focus();
    expect(input).toHaveFocus();

    const text = 'hello world';
    for (let i = 0; i < text.length; i += 1) {
      const value = text.slice(0, i + 1);
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
    }
    expect(input).toHaveValue(text);
  });

  it('an ordinary re-render while already open does not re-establish initial focus, preserving wherever the user has since moved focus', () => {
    function Harness(): ReactElement {
      const [tick, setTick] = useState(0);
      return (
        <Modal open onClose={vi.fn()} title="Test dialog" testId="test-modal">
          <button type="button">First</button>
          <button
            type="button"
            data-testid="second-field"
            onClick={() => {
              setTick((previous) => previous + 1);
            }}
          >
            Second (tick: {tick})
          </button>
        </Modal>
      );
    }
    render(<Harness />);
    const second = screen.getByTestId('second-field');
    second.focus();
    expect(second).toHaveFocus();

    // Clicking causes a state update and re-render (open stays true throughout) — must not reset
    // focus back to the first focusable element.
    fireEvent.click(second);
    expect(second).toHaveFocus();
  });

  it('Tab still moves focus and stays trapped inside the dialog after several re-renders caused by typing', () => {
    render(<ControlledFormModal open onClose={vi.fn()} />);
    const input = screen.getByTestId('form-input');
    input.focus();
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input).toHaveFocus();

    const closeButton = screen.getByRole('button', { name: 'Close' });
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(input).toHaveFocus();
  });

  it('Escape still closes the dialog after several re-renders caused by typing', () => {
    const onClose = vi.fn();
    render(<ControlledFormModal open onClose={onClose} />);
    const input = screen.getByTestId('form-input');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the trigger element after closing, even after typing caused several internal re-renders first', () => {
    function Harness(): ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Open
          </button>
          <ControlledFormModal
            open={open}
            onClose={() => {
              setOpen(false);
            }}
          />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();
    fireEvent.click(trigger);

    const input = screen.getByTestId('form-input');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });
});
