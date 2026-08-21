import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { Tooltip } from './Tooltip.js';
import styles from './IconButton.module.css';

interface IconButtonProps {
  readonly icon: LucideIcon;
  /** Always rendered as the button's real `aria-label` — required (not optional) so an icon-only
   * control can never ship without an accessible name (T13.1 accessibility rule #11). */
  readonly ariaLabel: string;
  /** Visible hover/focus tooltip text; defaults to `ariaLabel` when omitted — a caller only needs
   * to pass this separately when the tooltip should say something slightly different from the
   * accessible name (e.g. "Mute microphone" vs. "Unmute microphone" toggling with state). */
  readonly tooltip?: string;
  readonly onClick?: () => void;
  readonly active?: boolean;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly size?: 'small' | 'medium';
  readonly type?: 'button' | 'submit';
  /** Test-only hook — additive, never read by production code. */
  readonly 'data-testid'?: string;
}

/** Generic icon-only button primitive — wraps a lucide icon, always has a real accessible label,
 * and always shows a hover/focus tooltip via {@link Tooltip}. `active`/`danger` are purely visual
 * state hooks for callers (e.g. a toggled-on mic-mute button) — this component never owns any
 * production state itself. */
export function IconButton({
  icon: Icon,
  ariaLabel,
  tooltip,
  onClick,
  active = false,
  danger = false,
  disabled = false,
  size = 'medium',
  type = 'button',
  'data-testid': testId,
}: IconButtonProps): ReactElement {
  const classes = [
    styles.button,
    size === 'small' ? styles.small : styles.medium,
    active ? styles.active : '',
    danger ? styles.danger : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tooltip label={tooltip ?? ariaLabel}>
      <button
        type={type}
        aria-label={ariaLabel}
        aria-pressed={active}
        className={classes}
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
      >
        <Icon size={size === 'small' ? 16 : 18} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
