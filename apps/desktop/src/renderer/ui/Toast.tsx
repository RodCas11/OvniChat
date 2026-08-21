import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { IconButton } from './IconButton.js';
import styles from './Toast.module.css';

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly variant: ToastVariant;
}

interface ToastViewportProps {
  readonly toasts: readonly ToastItem[];
  readonly onDismiss: (id: number) => void;
}

/** Renders every currently-live toast, stacked bottom-right — the presentational half of
 * `ToastProvider.tsx`. */
export function ToastViewport({ toasts, onDismiss }: ToastViewportProps): ReactElement | null {
  if (toasts.length === 0) return null;

  return createPortal(
    <div className={styles.viewport} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`${styles.toast} ${styles[toast.variant]}`}>
          <span className={styles.message}>{toast.message}</span>
          <IconButton
            icon={X}
            ariaLabel="Dismiss notification"
            size="small"
            onClick={() => {
              onDismiss(toast.id);
            }}
          />
        </div>
      ))}
    </div>,
    document.body,
  );
}
