import type { ReactElement } from 'react';

import wordmarkDefault from '../../../assets/brand/chantivo-wordmark.svg';
import wordmarkWhite from '../../../assets/brand/chantivo-wordmark-white.svg';

interface ChantivoWordmarkProps {
  /** See `ChantivoMark`'s own doc comment — same dark-first reasoning, same default. */
  readonly variant?: 'default' | 'white';
  /** Height in px — width is left to the browser's own intrinsic-aspect-ratio sizing from the SVG's
   * `viewBox` (562.92 x 114.52, ~4.9:1), never a hardcoded width that could stretch/distort it. */
  readonly height?: number;
}

/**
 * T13.5 — the authoritative Chantivo wordmark, rendered directly via `<img>` — see `ChantivoMark`'s
 * own doc comment for the "never redrawn/approximated" policy this shares.
 */
export function ChantivoWordmark({
  variant = 'white',
  height = 24,
}: ChantivoWordmarkProps): ReactElement {
  return (
    <img
      src={variant === 'white' ? wordmarkWhite : wordmarkDefault}
      alt="Chantivo"
      height={height}
      draggable={false}
    />
  );
}
