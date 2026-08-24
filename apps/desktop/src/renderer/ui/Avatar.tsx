import type { ReactElement } from 'react';

import styles from './Avatar.module.css';

export type AvatarSize = 'small' | 'medium' | 'large' | 'xlarge';

/** A small, fixed palette of muted hues — deliberately not dominated by the Chantivo green accent
 * (that is reserved for active/selected/positive state, never a generic avatar fill; see
 * `tokens.css`'s own doc comment). Picking one deterministically from a name/id string below never
 * uses `Math.random()` or any other per-render-unstable source. */
const PALETTE = [
  '#5865a4',
  '#a45865',
  '#5aa478',
  '#a48958',
  '#7a58a4',
  '#4899a8',
  '#a4585c',
  '#63a458',
] as const;

/** Stable (non-cryptographic) string hash — deterministic across renders/sessions for the same
 * input, which is all this needs (a consistent fallback color per name/id, not a security
 * property). */
function hashString(value: string): number {
  let hash = 0;
  for (const codePoint of value) {
    hash = (hash * 31 + (codePoint.codePointAt(0) ?? 0)) | 0;
  }
  return Math.abs(hash);
}

/** Derives 1-2 uppercase initials from a display name, handling empty names, Unicode (grapheme-
 * unaware but codepoint-safe via `Array.from`, so surrogate pairs are never split), and very long
 * names (only ever the first codepoint of up to the first two whitespace-separated words is used,
 * so length has no effect on output size). */
export function initialsFor(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  const words = trimmed.split(/\s+/u).filter((word) => word.length > 0);
  const firstWord = words[0] ?? '';
  const first = Array.from(firstWord)[0];
  if (!first) return '?';
  if (words.length === 1) return first.toLocaleUpperCase();
  const secondWord = words[1] ?? '';
  const second = Array.from(secondWord)[0];
  return (first + (second ?? '')).toLocaleUpperCase();
}

/** Deterministically derives a fallback background color from a name/id string — same input always
 * produces the same color, for the same name/id, across every render and every session. */
export function colorFor(seed: string): string {
  if (seed.length === 0) return PALETTE[0];
  return PALETTE[hashString(seed) % PALETTE.length] ?? PALETTE[0];
}

interface AvatarProps {
  /** Display name (or id, for a not-yet-named entity) initials/color are derived from. */
  readonly name: string;
  /** A distinct, stable seed for color derivation when it should differ from `name` (e.g. a
   * bookmark id) — defaults to `name` when omitted. */
  readonly colorSeed?: string;
  readonly size?: AvatarSize;
  readonly shape?: 'circle' | 'square';
  readonly selected?: boolean;
  /** Prepared, not implemented, slot for a future real image source (T13.3) — when provided, a real
   * `<img>` replaces the initials fallback; omitted/`undefined` today everywhere this is used. */
  readonly imageUrl?: string | undefined;
}

/** Generic avatar base for `ServerAvatar`/`UserAvatar` — deterministic initials fallback (never
 * `Math.random()`, never per-render-unstable), with a prepared (not implemented) image slot for a
 * future task. */
export function Avatar({
  name,
  colorSeed,
  size = 'medium',
  shape = 'circle',
  selected = false,
  imageUrl,
}: AvatarProps): ReactElement {
  const classes = [
    styles.avatar,
    styles[size],
    shape === 'square' ? styles.square : styles.circle,
    selected ? styles.selected : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (imageUrl) {
    return (
      <span className={classes}>
        <img src={imageUrl} alt="" className={styles.image} />
      </span>
    );
  }

  return (
    <span className={classes} style={{ background: colorFor(colorSeed ?? name) }}>
      <span className={styles.initials}>{initialsFor(name)}</span>
    </span>
  );
}
