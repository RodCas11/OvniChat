import type { LucideIcon } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from './Button.js';
import styles from './EmptyState.module.css';

interface EmptyStateAction {
  readonly label: string;
  readonly onClick: () => void;
  /** Test-only hook for the action button — additive, never read by production code. */
  readonly testId?: string;
}

interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description?: string;
  readonly action?: EmptyStateAction;
}

/** Shared empty-state presentation — real data is simply absent (no bookmarks, no one in a
 * channel, no messages yet); never used to show fabricated placeholder content. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: EmptyStateProps): ReactElement {
  return (
    <div className={styles.container}>
      <Icon size={32} aria-hidden="true" className={styles.icon} />
      <p className={styles.title}>{title}</p>
      {description && <p className={styles.description}>{description}</p>}
      {action && (
        <Button variant="secondary" onClick={action.onClick} data-testid={action.testId}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
