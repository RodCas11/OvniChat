import type { ReactElement } from 'react';

import markDefault from '../../../assets/brand/chantivo-mark.svg';
import markWhite from '../../../assets/brand/chantivo-mark-white.svg';

interface ChantivoMarkProps {
  /** `'default'` (the dark-green mark, for light-ish/neutral surfaces) or `'white'` (for the app's
   * own near-black surfaces, e.g. the server rail) — this app is dark-first, so most real call sites
   * use `'white'`; `'default'` exists for the rare lighter surface (e.g. inside a light toast/tooltip
   * background) rather than being unused. */
  readonly variant?: 'default' | 'white';
  /** Square size in px — the mark's own `viewBox` is 256x256, so width and height are always equal. */
  readonly size?: number;
}

/**
 * T13.5 — the authoritative Chantivo mark (`apps/desktop/src/assets/brand/chantivo-mark*.svg`),
 * rendered directly via `<img>` from Vite's own asset URL import — never redrawn, traced, or
 * approximated with CSS/Lucide. See `docs/BRANDING.md` for the full asset inventory and usage policy.
 */
export function ChantivoMark({ variant = 'white', size = 32 }: ChantivoMarkProps): ReactElement {
  return (
    <img
      src={variant === 'white' ? markWhite : markDefault}
      alt="Chantivo"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
