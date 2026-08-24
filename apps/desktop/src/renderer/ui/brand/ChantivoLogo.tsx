import type { ReactElement } from 'react';

import { ChantivoMark } from './ChantivoMark.js';
import { ChantivoWordmark } from './ChantivoWordmark.js';
import styles from './ChantivoLogo.module.css';

interface ChantivoLogoProps {
  readonly variant?: 'default' | 'white';
  /** Mark size in px; the wordmark's height is derived to roughly match its visual weight rather
   * than exposed as a second prop every call site has to keep in sync. */
  readonly size?: number;
}

/**
 * T13.5 — the mark+wordmark lockup used for real product-identity moments (Home). Deliberately not
 * used inside ordinary workspace chrome (channel headers, Member Panel, per-section settings) — see
 * `docs/BRANDING.md`'s "restraint" policy: once connected to a server, the server is the primary
 * context, not the Chantivo brand.
 */
export function ChantivoLogo({ variant = 'white', size = 40 }: ChantivoLogoProps): ReactElement {
  return (
    <span className={styles.logo}>
      <ChantivoMark variant={variant} size={size} />
      <ChantivoWordmark variant={variant} height={Math.round(size * 0.6)} />
    </span>
  );
}
