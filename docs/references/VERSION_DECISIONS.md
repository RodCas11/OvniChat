# Version decisions

Snapshot: **2026-08-18**. JavaScript package versions are exact pins; the lockfile produced from them is the reproducible source of truth.

## Selected baseline

| Component                             | Exact version |
| ------------------------------------- | ------------: |
| Node.js (local/CI baseline, LTS line) |     `24.19.0` |
| pnpm                                  |     `11.22.0` |
| Electron                              |      `43.4.0` |
| React / React DOM                     |      `19.2.8` |
| `@types/react`                        |     `19.2.18` |
| `@types/react-dom`                    |      `19.2.4` |
| Vite                                  |       `7.3.6` |
| `@vitejs/plugin-react`                |       `5.2.0` |
| TypeScript                            |       `6.0.3` |
| `@types/node`                         |     `24.13.3` |
| ESLint                                |      `10.8.1` |
| `@eslint/js`                          |      `10.0.1` |
| `typescript-eslint`                   |      `8.67.0` |
| `globals`                             |     `17.11.0` |
| Vitest / `@vitest/coverage-v8`        |      `4.1.10` |
| Prettier                              |       `3.9.6` |
| `actions/checkout`                    |       `7.0.1` |
| `actions/setup-node`                  |       `7.0.0` |
| Security override: `tar`              |      `7.5.22` |
| Security override: `tmp`              |       `0.2.7` |
| Security patch: `extract-zip`         |       `2.0.1` |

`@electron/packager` is **not** overridden as of T1: it resolves to Forge 7.11.2's natural `18.4.4`.
See "T1 Electron Forge/packager compatibility findings" below for why the T0 override to `20.3.0`
was reverted.

Every installed `@electron-forge/*` package is pinned to **`7.11.2`**: `cli`, `plugin-fuses`, `plugin-vite`, and `shared-types`. `@electron/fuses` is pinned to **`1.8.0`**, which satisfies Forge 7.11.2's `^1.0.0` peer range. Do not mix Forge suite versions or adopt the Forge 8 prerelease by accident.

## Why these versions

- Electron `43.4.0` was released on 11 August 2026 and embeds Chromium `150.0.7871.224`, Node `24.18.1`, and V8 `15.0.245.28`. Electron supports the latest three stable major lines, currently 41-43. Electron 44 is scheduled for 25 August 2026, when 41 reaches end of support; do not upgrade across that boundary without a dedicated compatibility pass. Sources: [43.4.0 release](https://releases.electronjs.org/release/v43.4.0), [release timeline](https://www.electronjs.org/docs/latest/tutorial/electron-timelines), and [release schedule](https://releases.electronjs.org/schedule).
- Forge `7.11.2` is the current stable suite in this snapshot; `8.0.0-alpha.*` is prerelease. Keep its packages aligned. Source: [Forge 7.11.2 release](https://github.com/electron/forge/releases/tag/v7.11.2).
- Forge labels its Vite plugin **experimental** and warns that minor releases may contain breaking changes. Vite `7.3.6` plus `@vitejs/plugin-react` `5.2.0` is this repository's conservative compatibility choice while Forge 7 remains on its current plugin architecture; it is an engineering decision, not an official Forge compatibility guarantee. Do not move to Vite 8 during T0. Sources: [Forge Vite plugin](https://www.electronforge.io/config/plugins/vite), [Forge Vite + TypeScript template](https://www.electronforge.io/templates/vite-%2B-typescript), and [Vite releases](https://vite.dev/releases).
- TypeScript `6.0.3` stays inside `typescript-eslint` `8.67.0`'s declared TypeScript peer range (`>=4.8.4 <6.1.0`). TypeScript 7 is therefore intentionally deferred. Source: [`typescript-eslint` 8.67.0 registry metadata](https://registry.npmjs.org/typescript-eslint/8.67.0).
- pnpm uses `nodeLinker: hoisted` in `pnpm-workspace.yaml` because Forge's packaging dependency traversal does not reliably understand pnpm's default symlink layout. pnpm 11 reads non-registry project settings from that YAML rather than `.npmrc`. Exact saves, strict engines/peers, and an explicit build-script allowlist make drift visible. Sources: [Forge pnpm note](https://www.electronforge.io/) and [pnpm 11 settings](https://pnpm.io/settings).
- Forge 7.11.2 transitively pins Electron's MIT-licensed `@electron/node-gyp` fork at commit `06b29aafb7708acef8b3669835c8a7857ebc92d2`. pnpm 11 therefore needs `blockExoticSubdeps: false`; `pnpm verify:dependencies` compensates by rejecting every exotic lockfile URL except that exact codeload URL. Re-review this exception whenever Forge or `@electron/rebuild` changes. Source: [`@electron/rebuild` 3.7.2 registry metadata](https://registry.npmjs.org/@electron/rebuild/3.7.2).
- **(T0, superseded by T1 — see the dedicated section below)** Forge 7.11.2's original transitive graph resolved `@electron/packager` 18.4.4, `tar` 6.2.1, `extract-zip` 2.0.1, and `tmp` 0.0.33, and T0's `pnpm audit` reported one critical and nine high advisories in that build-only graph. T0 provisionally overrode packager to `20.3.0` on the theory that its download-option breaking change was the only compatibility risk. T1 actually ran the Forge start/package gate this note demanded and found a different, more fundamental incompatibility: see "T1 Electron Forge/packager compatibility findings" below. The packager override has been reverted.
- TypeScript uses `skipLibCheck: true` because Forge 7.11.2 publishes a `plugin-vite` declaration that references an undeclared `NewCtx`, while its `listr2` declaration references an undeclared optional `rxjs` package. Project source remains fully strict and type-checked; remove this workaround when the stable Forge line fixes its declaration surface.
- `.node-version` and CI pin the exact Node `24.19.0` development baseline. The package `engines` field accepts the maintained Node 24 line as a compatibility range; it is not the reproducible CI selector.
- GitHub Actions uses the current stable `actions/checkout` `7.0.1` and `actions/setup-node` `7.0.0` releases, pinned by full commit SHA rather than mutable major tags. Sources: [checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) and [setup-node 7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0).

## T1 Electron Forge/packager compatibility findings (2026-08-18)

T1 ran the actual Forge start/package gate this document had deferred, on Node `24.19.0` /
pnpm `11.22.0` / Windows 11 x64. Two real, previously-unproven incompatibilities surfaced.

### `@electron/packager` 20.3.0 breaks Forge 7.11.2 packaging (reverted)

`electron-forge package` failed immediately with `TypeError: done is not a function` inside
`@electron-forge/core/dist/api/package.js`. Root cause, confirmed against the packager
[v19.0.0 release notes](https://github.com/electron/packager/releases/tag/v19.0.0): packager
`19.0.0` promisified every lifecycle hook (`afterCopy`, `afterPrune`, `afterExtract`,
`afterComplete`, `afterFinalizePackageTargets`) — hooks now take one options object and return a
promise instead of `(...args, done)` with a Node-style callback. Forge 7.11.2's packaging
pipeline still wraps every one of those five hook groups in the old callback convention
(`sequentialHooks`/`sequentialFinalizePackageTargetsHooks` in `@electron-forge/core`), so packager
`19+` makes every `electron-forge package` run crash — this is pervasive, not a narrow edge case,
and one of the silently-broken (non-crashing but never-firing) hook groups is exactly the one
Forge's own Vite plugin uses to rewrite `package.json` into the packaged app
(`VitePlugin.packageAfterCopy`). Forge `8.0.0-alpha.10` is the only line with updated hook
handling and remains prerelease (see the pinned suite note above); adopting it was rejected.

**Decision:** `@electron/packager` is no longer overridden. It resolves to Forge 7.11.2's natural
`18.4.4`, which uses the old callback hook API and packages successfully. Verified: `electron-forge
package` completes cleanly; the packaged `apps/desktop/out/@disco-voador-desktop-win32-x64/@disco-voador-desktop.exe`
launches, renders through the `app://` protocol, and quits cleanly; `@electron/fuses read` on the
exe confirms all six configured fuses (`RunAsNode` disabled, `EnableCookieEncryption` enabled,
`EnableNodeOptionsEnvironmentVariable` disabled, `EnableNodeCliInspectArguments` disabled,
`EnableEmbeddedAsarIntegrityValidation` enabled, `OnlyLoadAppFromAsar` enabled).

### `extract-zip` 2.0.1 (packager 18.4.4's dependency) has no upstream fix

Reverting to packager `18.4.4` reintroduces exactly one advisory (T0's "one critical and nine
high" had already shrunk since the ecosystem moved on; only this one remained by 2026-08-18):
`extract-zip@2.0.1`'s unvalidated symlink-target write, [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv)
/ CVE-2026-56876 (high, CVSS 8.1). The advisory's own `first_patched_version` is `null` — no
fixed release exists; packager `19+` worked around it by removing the `extract-zip` dependency
entirely in favor of Electron's own hardened extractor, which is unavailable to us for the reason
above.

**Decision:** patched via `pnpm patch` (`patches/extract-zip@2.0.1.patch`, registered in
`pnpm-workspace.yaml`'s `patchedDependencies`). The patch adds a containment check on the resolved
symlink _target_ before calling `fs.symlink()`, mirroring the check `extract-zip` already applies
to each entry's own path a few lines above it in `index.js`. The advisory is recorded as an
accepted exception in `pnpm-workspace.yaml`'s `auditConfig.ignoreGhsas` (which `pnpm audit` reads
natively, so `pnpm check`'s audit gate passes without a CLI flag).

- **Owner:** apps/desktop maintainers (build tooling, not shipped product code).
- **Scope:** build-time only — `extract-zip` runs during `electron-forge package`/`start` to
  unpack Electron's own official prebuilt zip downloaded by `@electron/get` from Electron's
  release CDN. It is never bundled into the shipped app and never processes attacker-controlled
  archives in this pipeline.
- **Expiry/follow-up:** revisit whenever `@electron-forge/core` ships packager `19+` support
  (watch the Forge 7.x line, or Forge 8 leaving prerelease) — the patch and the packager pin can
  both be dropped together. Re-run `pnpm audit` after any Forge/packager bump regardless.

### Two related runtime gotchas discovered while wiring the custom `app://` protocol

- Node's `URL#origin` returns the literal string `"null"` for non-special schemes (only http,
  https, ws, wss, ftp, file get real origin computation per the WHATWG URL spec) — including our
  registered `app:` scheme, despite it being privileged as `standard: true` in Electron. Origin
  comparisons for navigation/window-open/IPC-sender checks compute
  `` `${url.protocol}//${url.host}` `` manually instead (`apps/desktop/src/main/origins.ts`).
- Vite/Forge's default per-entry output filename is derived from the entry file's own basename.
  Since both `src/main/index.ts` and `src/preload/index.ts` share the basename `index`, the
  default config would silently collide on `.vite/build/index.js` for both. `vite.main.config.ts`
  and `vite.preload.config.ts` now pin explicit `main.cjs`/`preload.cjs` output filenames; the
  `.cjs` extension (rather than `.js`) also removes any ambiguity from `apps/desktop/package.json`'s
  `"type": "module"`, since a `.cjs` file is unconditionally CommonJS regardless of that field.

## T3 finding: `ELECTRON_RUN_AS_NODE` must be absent, not empty, for a spawned unpackaged Electron child

`apps/desktop/scripts/e2e-voice-smoke.mjs` (T3's automated two-instance voice smoke test) spawns the
raw `electron` binary directly against `apps/desktop`'s source directory (unpackaged — the packaged
`.exe`'s `RunAsNode` fuse is disabled per "Required T1 validation" above, so this class of bug cannot
reach a real packaged build at all). It originally set `ELECTRON_RUN_AS_NODE: ''` in the child's
`env`, intending to guarantee Electron never falls back to running as plain Node even if the parent
shell had the variable set (observed in at least one CI-like sandbox, where it was `1`).

That assumption was wrong. Electron's native bootstrap checks the variable's **presence** (via
`getenv()`/`GetEnvironmentVariable()`), not its truthiness — a present-but-empty value still routes
through the Node-fallback bootstrap path. On real Windows hardware running Electron `43.4.0`, this
produced an immediate native crash before any window opened:

```text
Assertion failed: (isolate_data->snapshot_data()) != nullptr
  in node::CreateEnvironment
exit code 134
```

consistent with Electron 43's Node-startup-snapshot bootstrap expecting the snapshot data that only
the real Electron main-process path provides — the Node-fallback path does not.

**Decision:** `apps/desktop/scripts/lib/electron-e2e-env.mjs`'s `buildElectronE2EEnvironment` now
`delete`s the key from the spawned child's environment object entirely, rather than assigning any
string value to it. Regression-tested in `tests/desktop/electron-e2e-env.test.mjs` (proves genuine
absence — not `''`, `'0'`, or `'false'` — even when the parent environment has the variable set, and
even if an override object tries to reintroduce it). After this fix, `pnpm --filter
@disco-voador/desktop run e2e:voice-smoke` passed three consecutive times with real, non-repeating
evidence (distinct participant UUIDs, distinct ephemeral ports, distinct non-silent RMS audio-level
readings each run) — see `docs/tasks/T3_VOICE_WEBRTC.md` for the full record.

## Required T1 validation — result

Both `electron-forge start` (development) and `electron-forge package` (production, `win32`/`x64`)
were run through the repository's own scripts on Node `24.19.0` and manually verified end to end:
window opens, main/preload/renderer bundles load, the `app://` custom protocol serves the
packaged renderer, CSP is active in both modes, the preload bridge round-trips through IPC with
sender-origin validation, and the app quits cleanly (zero leftover processes) in both dev and
packaged form. See `docs/tasks/T1_ELECTRON_SHELL.md` for the full manual verification record.

Version sources: [Node.js 24 archive](https://nodejs.org/en/download/archive/v24), [Electron releases](https://releases.electronjs.org/releases.json), [`@electron/packager` releases](https://github.com/electron/packager/releases), and package-specific metadata from the [npm registry](https://registry.npmjs.org/).
