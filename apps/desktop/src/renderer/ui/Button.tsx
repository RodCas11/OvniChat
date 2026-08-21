import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';

import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  readonly variant?: ButtonVariant;
  readonly type?: 'button' | 'submit';
  readonly fullWidth?: boolean;
  readonly children: ReactNode;
  /** Test-only hook — additive, never read by production code. Explicitly typed (rather than
   * relying on TypeScript's native-element `data-*` leniency, which does not extend to a custom
   * component's own declared prop type) so callers can pass it without a cast. */
  readonly 'data-testid'?: string | undefined;
}

/**
 * Generic primitive button — no app-specific logic. `variant="ghost"` is the "ghost-icon"
 * treatment the task brief describes (transparent surface, text/icon only, subtle hover) — used for
 * a labeled text+icon action that should not compete visually with `primary`/`secondary`/`danger`.
 * A real `<button>` element always — never a clickable `<div>` (see `docs/SECURITY.md`/T13.1
 * accessibility rules).
 */
export function Button({
  variant = 'secondary',
  type = 'button',
  fullWidth = false,
  className,
  children,
  ...rest
}: ButtonProps): ReactElement {
  const classes = [styles.button, styles[variant], fullWidth ? styles.fullWidth : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
