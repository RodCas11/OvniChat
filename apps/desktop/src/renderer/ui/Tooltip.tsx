import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import styles from './Tooltip.module.css';

interface TooltipProps {
  readonly label: string;
  readonly children: ReactElement;
  readonly placement?: 'top' | 'bottom';
}

/**
 * Simple hover/focus-triggered tooltip for icon-only buttons and other controls whose visible
 * label would otherwise be missing — the accessible name still comes from the trigger's own
 * `aria-label`/text content (see `IconButton.tsx`); this only adds a visible, dismissible-by-moving-
 * away label, described via `aria-describedby`. Clamped to the viewport horizontally by measuring
 * its own rendered position after showing — this app runs inside a single fixed-size Electron
 * window, so a lightweight post-render measurement (no floating-ui/popper dependency) is enough.
 */
export function Tooltip({ label, children, placement = 'top' }: TooltipProps): ReactElement {
  const [visible, setVisible] = useState(false);
  const [shiftX, setShiftX] = useState(0);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!visible) {
      setShiftX(0);
      return;
    }
    const node = tooltipRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 8;
    let shift = 0;
    if (rect.left < margin) shift = margin - rect.left;
    else if (rect.right > window.innerWidth - margin) {
      shift = window.innerWidth - margin - rect.right;
    }
    if (shift !== 0) setShiftX(shift);
  }, [visible]);

  // Escape dismisses a visible tooltip, matching every other dismissible overlay in this design
  // system (Modal, ContextMenu) — T13.1 accessibility rule #11.
  useEffect(() => {
    if (!visible) return undefined;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setVisible(false);
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible]);

  if (!isValidElement<{ readonly 'aria-describedby'?: string | undefined }>(children)) {
    return children;
  }

  const trigger = cloneElement(children, {
    'aria-describedby': visible ? id : undefined,
  });

  return (
    <span
      className={styles.wrapper}
      onMouseEnter={() => {
        setVisible(true);
      }}
      onMouseLeave={() => {
        setVisible(false);
      }}
      onFocusCapture={() => {
        setVisible(true);
      }}
      onBlurCapture={() => {
        setVisible(false);
      }}
    >
      {trigger}
      {visible && (
        <span
          ref={tooltipRef}
          id={id}
          role="tooltip"
          className={`${styles.tooltip} ${placement === 'bottom' ? styles.bottom : styles.top}`}
          style={{ transform: `translateX(calc(-50% + ${String(shiftX)}px))` }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
