import { useEffect, useRef, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { IconButton } from './IconButton.js';
import styles from './Modal.module.css';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: 'small' | 'medium' | 'large' | 'xlarge';
  /** Test-only hook, applied to the dialog's own root element — additive, never read by production
   * code. */
  readonly testId?: string;
}

/**
 * Shared dialog primitive used by every settings/dialog surface in the app (AddServerDialog,
 * EditServerDialog, Settings). Closes on Escape and backdrop click, and does a reasonable focus
 * trap (Tab wraps within the dialog's own focusable elements; focus returns to whatever triggered
 * it on close) — not a full W3C dialog pattern implementation, but real, working keyboard behavior,
 * per the task's own "reasonable, not exhaustive" scope.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'medium',
  testId,
}: ModalProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  // Captured during render, not in an effect: React applies a child's own `autoFocus` prop (e.g. a
  // form's name input) via `commitMount`, which runs as part of the same commit's mutation phase —
  // strictly before *any* effect (layout or passive) fires, this component's own included. By the
  // time any effect below could read `document.activeElement`, a child's `autoFocus` has already
  // moved it, so it's too late to tell "what was focused before this dialog opened" from there. This
  // render-time read (a React-sanctioned "adjust state during render" pattern, gated so it only ever
  // fires once per closed→open transition) runs before that commit, while `document.activeElement`
  // still genuinely reflects whatever triggered the dialog.
  if (open && !wasOpenRef.current) {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
  }
  wasOpenRef.current = open;
  // Found live (T13.4 QA): every real consumer of this dialog passes an inline `onClose` — a fresh
  // function identity on every render — and a controlled form input re-renders its owner on every
  // keystroke. This effect used to depend on `[open, onClose]`, so typing anywhere in a modal form
  // re-ran the whole "establish initial focus" effect on every keystroke even though `open` itself
  // never changed: the cleanup and re-run always resolved initial focus to the first focusable
  // element in DOM order (the header Close button, which precedes the form body), yanking focus out
  // of the field the user was actively typing into. Reading the latest `onClose` through a ref keeps
  // Escape always current without needing `onClose` in the dependency array, so the effect below only
  // ever runs on a genuine closed<->open transition, never on an ordinary re-render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;

    // A consumer may mark exactly one field `autoFocus` to claim initial focus (e.g. a form's own
    // name input). React itself already focuses it before this effect runs (see the render-time
    // capture above) — if `document.activeElement` is already inside this dialog, that claim wins
    // and must not be overridden by the default "first focusable element" fallback (usually the
    // header Close button, rarely the field a dialog actually wants focused first).
    const dialogNode = dialogRef.current;
    const alreadyFocusedInside =
      dialogNode !== null &&
      document.activeElement instanceof Node &&
      dialogNode.contains(document.activeElement);
    if (!alreadyFocusedInside) {
      const focusable = dialogNode?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      (focusable?.[0] ?? dialogNode)?.focus();
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!nodes || nodes.length === 0) return;
      const list = Array.from(nodes);
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previouslyFocusedRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  return createPortal(
    <div className={styles.backdrop} onMouseDown={handleBackdropMouseDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`${styles.dialog} ${styles[size]}`}
        data-testid={testId}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          {/* T13.1.1 — closing a dialog is a neutral, routine action, not a primary one: dimmed to
              `--chantivo-text-tertiary` by default (full-strength only on hover/focus) so it reads with
              less visual weight than the dialog's actual primary actions (e.g. a Settings section's
              destructive controls, or a form's submit button). */}
          <div className={styles.closeButtonWrap}>
            <IconButton icon={X} ariaLabel="Close" onClick={onClose} size="small" />
          </div>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
