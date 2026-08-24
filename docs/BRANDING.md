# Branding

## Official identity

- **Official public product name:** Chantivo
- **Official public domain:** chantivo.app

chantivo.app is a product domain only — it names the product, nothing more. It is **not** a runtime
dependency: the app never calls it, never checks it, and works fully offline against any operator's
own Dedicated Server with no network path to it at all.

The product was marketed as "OvniChat" from T10 through T13.4. Historical task documents and ADRs
from that period legitimately still say "OvniChat" — they describe what was true at the time and are
not rewritten (see [`PRODUCT.md`](PRODUCT.md)'s own naming note). Current product-facing UI and
current-state documentation say "Chantivo."

## Internal namespace policy

`@disco-voador/*` remains the internal npm package scope, and `disco-voador`/"Disco Voador" remains
this repository's own directory/workspace name. This is a purely internal technical identifier — it
is never shown to a normal user and is not migrated by this rename. Do not confuse it with the public
product name. A future, separately scoped, fully verified rename task could migrate it; T13.5
deliberately does not.

## Renderer source assets (authoritative)

`apps/desktop/src/assets/brand/` is the single source of truth for every brand asset. These files are
used directly — never redrawn, traced, approximated with CSS, or recreated with an icon library:

| File                                             | Purpose                                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chantivo-mark.svg`                              | Mark (icon only), default (dark-green) variant                                                                                                                           |
| `chantivo-mark-white.svg`                        | Mark, white variant — for dark surfaces (this app's default)                                                                                                             |
| `chantivo-wordmark.svg`                          | Wordmark (text lockup), default variant                                                                                                                                  |
| `chantivo-wordmark-white.svg`                    | Wordmark, white variant — for dark surfaces                                                                                                                              |
| `chantivo-icon-512.png` … `chantivo-icon-32.png` | Rasterized mark at fixed sizes, available if a future consumer needs a raster rather than the SVG (unused by the current Renderer/packaging code, kept for completeness) |
| `chantivo.ico`                                   | Windows multi-resolution icon — the authoritative Windows app/executable icon                                                                                            |

Consumed by three small presentation components in `apps/desktop/src/renderer/ui/brand/`:
`ChantivoMark`, `ChantivoWordmark`, `ChantivoLogo` (mark+wordmark lockup) — each renders the real SVG
file via a plain `<img>` (Vite's default asset-URL import), so the authoritative markup is never
touched. `variant: 'default' | 'white'` selects which pair to render; this app is dark-first, so
`'white'` is the default for all three.

## Packaging copy

`chantivo.ico` is additionally copied to `apps/desktop/resources/chantivo.ico` because
`forge.config.ts`'s `packagerConfig.icon` (which embeds the icon into the packaged Windows
executable) and the dev/packaged `BrowserWindow` icon resolution (`main/window.ts`) both need a
stable on-disk path outside anything Vite/Rollup's bundling touches. **The Renderer source copy under
`src/assets/brand/` remains authoritative** — the packaging copy is a plain, unmodified duplicate, not
a second source of truth; if the mark/icon is ever updated, update `src/assets/brand/chantivo.ico`
and re-copy it to `resources/`.

## Canonical brand token

`apps/desktop/src/renderer/styles/tokens.css`:

- `--chantivo-brand: #3f7353` — the exact official mark color (from `chantivo-mark.svg`'s own `fill`).
  Used for logo-adjacent identity touches where matching the mark exactly matters more than on-dark
  UI-control contrast.
- `--chantivo-brand-subtle` — a low-alpha wash of the same color, for a restrained background tint.
- `--chantivo-accent` / `--chantivo-accent-hover` / `--chantivo-accent-fg` — the same brand hue,
  brightened for legible on-dark interactive use (buttons, selected/positive state, the speaking-ring
  indicator). This is the token every ordinary component should reach for; `--chantivo-brand` itself
  is reserved for real identity moments (Home, About), not scattered through ordinary controls.
- `--chantivo-focus-ring` (T13.5.1) — a dedicated, 70%-opacity variant of the accent hue, deliberately
  _not_ the same full-strength value `--chantivo-accent` uses. A keyboard-focus outline is a "you are
  here" indicator, not a call to action; using the identical full-saturation color for both made a
  merely-focused control (e.g. a modal's Close button, auto-focused on open) read as a primary CTA.
  Paired with `global.css`'s own `:focus-visible` rule (1.5px outline, 1px offset — down from
  2px/2px), it stays a real, always-visible outline everywhere, just a visually quieter one.

Every other design token (`--chantivo-bg-*`, `--chantivo-text-*`, `--chantivo-space-*`, etc.) was
renamed from its previous `--ovni-*` prefix for consistency — a pure token-name rename, values
unchanged except where noted above.

## Icon usage

- Windows executable / taskbar / Start Menu: `chantivo.ico` via `packagerConfig.icon` (packaged) and
  `BrowserWindow`'s own `icon` option (dev, resolved by `main/window.ts`).
- In-app: `ChantivoMark` (icon only) for compact contexts, `ChantivoLogo` (mark+wordmark) for real
  identity moments (Home). Never the full wordmark inside a small icon-sized slot.

## Restraint policy

Once connected to a server, the server is the primary context — not the Chantivo brand. The
mark/wordmark are deliberately absent from channel headers, the Member Panel, the chat header, and
every settings subsection except the dedicated About subsection (Settings → Advanced → About). No
watermark or logo overlay is ever placed on shared/streamed content.

## What this rename explicitly does not do

- No internal package/namespace rename (`@disco-voador/*` stays).
- No change to any protocol/storage identifier.
- No mandatory runtime dependency on chantivo.app or any Chantivo-operated service.
- No login, account, subscription, or telemetry surface introduced anywhere.
