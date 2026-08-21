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
  readonly size?: 'small' | 'medium' | 'large';
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

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    (focusable?.[0] ?? dialogRef.current)?.focus();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
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
  }, [open, onClose]);

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
          <IconButton icon={X} ariaLabel="Close" onClick={onClose} size="small" />
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
