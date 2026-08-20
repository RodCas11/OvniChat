# ADR 0015: Local client settings and server bookmarks live in `apps/desktop/src/main/settings/`

## Status

Accepted and implemented (T11).

## Context

T11 needed the OvniChat Client's first genuine local-settings concern: device preferences (selected
microphone/camera/output), a screen-share quality default, mute/deafen-on-launch preferences, and a
list of local server bookmarks (display name + address only — never a bearer token). The task's own
spec required determining whether this belongs in the existing `packages/config` workspace, a new
package, or alongside the existing `apps/desktop/src/main/identity/` persistence code, and what
corruption-recovery discipline to apply.

A `software-architect` review was conducted before implementation, alongside a parallel review of the
reconnect-controller placement (see ADR 0016) and the `replaceTrack` transport addition.

## Decision

**`apps/desktop/src/main/settings/settings-file.ts` + `settings-service.ts`, a new sibling of
`apps/desktop/src/main/identity/`, reusing `identity/atomic-write.ts`'s `writeFileAtomic` verbatim.**
Not `packages/config`: that workspace's own README explicitly scopes it to environment-variable-shaped
deployment configuration validation (`parseConfig` against `Record<string, string | undefined>`), used
identically by `apps/desktop/src/main/desktop-config.ts` and `services/dedicated-server/src/config.ts`
today — growing it to also own file-backed user settings would blur an already-clean boundary for no
reuse benefit (env-var parsing and JSON-file persistence share no real implementation). Not a new
`packages/` workspace: this is Renderer-facing local product state with exactly one consumer
(`apps/desktop`), the same "no second real consumer, no package" reasoning ADR 0013/0014 already
established for the Dedicated Server's own storage modules.

**Single file, `%APPDATA%/DiscoVoador/settings.json`, versioned and `.strict()`-zod-validated —
deliberately _not_ consolidated with `identity/nickname-store.ts`'s existing `preferences.json`.**
Three local files now exist, each with a corruption-recovery discipline suited to what it protects:

| File                          | Sensitivity                                                   | Corruption discipline                                                 |
| ----------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `identity/identity.json`      | Cryptographic (T7)                                            | Fail-closed: throws, never silently regenerates                       |
| `preferences.json` (nickname) | None — trivially re-enterable                                 | Fail-open: silently resets to `''` (first-run state)                  |
| `settings.json` (T11)         | None, but a bookmark list is real, non-trivial daily-use data | Fail-open, but **section-by-section salvage**, not a whole-file reset |

Merging nickname into `settings.json` was considered and rejected: `nickname-store.ts` is small,
stable, already reviewed (T7), and has its own documented product rationale ("nickname is explicitly
not identity"). Folding it in would be a pure refactor of already-shipped code with no T11 requirement
behind it, touching a security-adjacent file for zero functional gain.

**Section-by-section salvage, not whole-file reset, on corruption.** Each top-level section
(`audio`, `video`, `screenShare`, `voice`, `bookmarks`, `lastServerAddress`, `connectOnStartup`) is
validated independently; a malformed `screenShare` section falls back to its own default without
discarding an otherwise-valid `bookmarks` list — the section most costly for a daily user to lose. The
original corrupt file is renamed aside (`settings.json.corrupted-<timestamp>`), never overwritten or
deleted in place, so the original bytes survive for manual inspection; the salvaged result is
immediately written back as the new `settings.json` so the recovery survives a second restart, not
only the current session. This directly satisfies the task's own requirement: "do not silently
overwrite corrupt settings with an empty file before giving the application a chance to recover
safely."

**Bookmarks carry only `bookmarkId` / `displayName` / `serverAddress` — never a token.** An
invite/privilege/bootstrap bearer token remains exactly as ephemeral as it already was
(`ConnectionScreen`'s `serverToken` field, cleared immediately after one connect attempt, per T9
Section 72) — no code path threads a token into the bookmark-add flow at all, so there is no
plaintext-credential-at-rest regression to defend against later.

**Narrow IPC, mirroring the existing `getNickname`/`setNickname` shape**: `getClientSettings`,
`updateClientSettings(patch)`, `addBookmark`, `updateBookmark`, `removeBookmark` — five methods, each
validated against a `.strict()` zod schema in `main/ipc.ts` before reaching the store, matching this
codebase's "never trust the Renderer's shape" discipline (`identityChallengeSchema` is the established
precedent). `updateClientSettings` merges field-by-field via an explicit `!== undefined` check, not
`??` or an object spread — see `settings-service.ts`'s own doc comment: Electron IPC crosses via
structured clone, not `JSON.stringify`, so a caller can send a field explicitly set to `undefined`
(distinct from omitting it), and `null` is itself a meaningful device-preference value ("use the
system default"), so `??` would incorrectly treat a deliberate reset-to-default as "not provided."

## Consequences

- `apps/desktop` gains its first genuine local-settings module without touching `packages/config`'s
  scope or introducing a new workspace.
- Three independent local files, three independently-reasoned-about corruption disciplines — a future
  engineer adding a fourth persisted concern should pick deliberately from this same menu rather than
  defaulting to whichever file is closest.
- `settings.json`'s schema is additive-friendly: each section validates independently, so a future
  T-something adding a new top-level section does not need to bump the file version or risk an
  unrelated section's validation failure cascading into data loss.
- No cross-server or cross-device correlation is introduced: bookmarks, device ids, and preferences
  are never sent to any Dedicated Server (see `docs/SECURITY.md`'s T11 section).

## Alternatives

- **Extend `packages/config`:** rejected — see Decision above; would blur an intentionally narrow
  package boundary for no reuse benefit.
- **A new `packages/client-settings` workspace:** rejected — no second consumer, no trust-boundary
  argument, mirrors ADR 0013/0014's identical reasoning for the server-side stores.
- **Consolidate with `nickname-store.ts`:** rejected — no T11 requirement, unnecessary churn to
  already-shipped, already-reviewed code.
- **Whole-file fail-open reset on any corruption (matching `nickname-store.ts` exactly):** considered
  as the simpler fallback the architecture review flagged as acceptable if section-salvage proved too
  costly; implemented section-salvage anyway since the marginal cost was low and a bookmark list is
  qualitatively more valuable to a daily user than a nickname.
