# Version decisions

Snapshot: **2026-08-18**. JavaScript package versions are exact pins; the lockfile produced from them is the reproducible source of truth.

## Selected baseline

| Component                               | Exact version |
| --------------------------------------- | ------------: |
| Node.js (local/CI baseline, LTS line)   |     `24.19.0` |
| pnpm                                    |     `11.22.0` |
| Electron                                |      `43.4.0` |
| React / React DOM                       |      `19.2.8` |
| `@types/react`                          |     `19.2.18` |
| `@types/react-dom`                      |      `19.2.4` |
| Vite                                    |       `7.3.6` |
| `@vitejs/plugin-react`                  |       `5.2.0` |
| TypeScript                              |       `6.0.3` |
| `@types/node`                           |     `24.13.3` |
| ESLint                                  |      `10.8.1` |
| `@eslint/js`                            |      `10.0.1` |
| `typescript-eslint`                     |      `8.67.0` |
| `globals`                               |     `17.11.0` |
| Vitest / `@vitest/coverage-v8`          |      `4.1.10` |
| Prettier                                |       `3.9.6` |
| `actions/checkout`                      |       `7.0.1` |
| `actions/setup-node`                    |       `7.0.0` |
| Security override: `@electron/packager` |      `20.3.0` |
| Security override: `tar`                |      `7.5.22` |
| Security override: `tmp`                |       `0.2.7` |

Every installed `@electron-forge/*` package is pinned to **`7.11.2`**: `cli`, `plugin-fuses`, `plugin-vite`, and `shared-types`. `@electron/fuses` is pinned to **`1.8.0`**, which satisfies Forge 7.11.2's `^1.0.0` peer range. Do not mix Forge suite versions or adopt the Forge 8 prerelease by accident.

## Why these versions

- Electron `43.4.0` was released on 11 August 2026 and embeds Chromium `150.0.7871.224`, Node `24.18.1`, and V8 `15.0.245.28`. Electron supports the latest three stable major lines, currently 41-43. Electron 44 is scheduled for 25 August 2026, when 41 reaches end of support; do not upgrade across that boundary without a dedicated compatibility pass. Sources: [43.4.0 release](https://releases.electronjs.org/release/v43.4.0), [release timeline](https://www.electronjs.org/docs/latest/tutorial/electron-timelines), and [release schedule](https://releases.electronjs.org/schedule).
- Forge `7.11.2` is the current stable suite in this snapshot; `8.0.0-alpha.*` is prerelease. Keep its packages aligned. Source: [Forge 7.11.2 release](https://github.com/electron/forge/releases/tag/v7.11.2).
- Forge labels its Vite plugin **experimental** and warns that minor releases may contain breaking changes. Vite `7.3.6` plus `@vitejs/plugin-react` `5.2.0` is this repository's conservative compatibility choice while Forge 7 remains on its current plugin architecture; it is an engineering decision, not an official Forge compatibility guarantee. Do not move to Vite 8 during T0. Sources: [Forge Vite plugin](https://www.electronforge.io/config/plugins/vite), [Forge Vite + TypeScript template](https://www.electronforge.io/templates/vite-%2B-typescript), and [Vite releases](https://vite.dev/releases).
- TypeScript `6.0.3` stays inside `typescript-eslint` `8.67.0`'s declared TypeScript peer range (`>=4.8.4 <6.1.0`). TypeScript 7 is therefore intentionally deferred. Source: [`typescript-eslint` 8.67.0 registry metadata](https://registry.npmjs.org/typescript-eslint/8.67.0).
- pnpm uses `nodeLinker: hoisted` in `pnpm-workspace.yaml` because Forge's packaging dependency traversal does not reliably understand pnpm's default symlink layout. pnpm 11 reads non-registry project settings from that YAML rather than `.npmrc`. Exact saves, strict engines/peers, and an explicit build-script allowlist make drift visible. Sources: [Forge pnpm note](https://www.electronforge.io/) and [pnpm 11 settings](https://pnpm.io/settings).
- Forge 7.11.2 transitively pins Electron's MIT-licensed `@electron/node-gyp` fork at commit `06b29aafb7708acef8b3669835c8a7857ebc92d2`. pnpm 11 therefore needs `blockExoticSubdeps: false`; `pnpm verify:dependencies` compensates by rejecting every exotic lockfile URL except that exact codeload URL. Re-review this exception whenever Forge or `@electron/rebuild` changes. Source: [`@electron/rebuild` 3.7.2 registry metadata](https://registry.npmjs.org/@electron/rebuild/3.7.2).
- Forge 7.11.2's original transitive graph resolved `@electron/packager` 18.4.4, `tar` 6.2.1, `extract-zip` 2.0.1, and `tmp` 0.0.33. On 2026-08-18, `pnpm audit` reported one critical and nine high advisories in that build-only graph. The root therefore overrides packager to `20.3.0`, tar to `7.5.22`, and tmp to `0.2.7`; packager 20 uses Electron's hardened internal extractor and removes `extract-zip`. The resulting lockfile reports no known advisories. Sources: [Packager 20 releases](https://github.com/electron/packager/releases), [`tar` registry metadata](https://registry.npmjs.org/tar/7.5.22), and [`tmp` registry metadata](https://registry.npmjs.org/tmp/0.2.7).
- The packager override crosses a major version ahead of Forge 7's declared range. Packager 20's documented breaking change concerns its download-option API, which this scaffold does not configure, but compatibility remains a project inference rather than a Forge guarantee. T1 must run the actual Forge start/package and packaged-executable smoke gate before accepting this build stack. Do not remove or move an override merely to silence resolution friction; rerun the audit and compatibility gate.
- TypeScript uses `skipLibCheck: true` because Forge 7.11.2 publishes a `plugin-vite` declaration that references an undeclared `NewCtx`, while its `listr2` declaration references an undeclared optional `rxjs` package. Project source remains fully strict and type-checked; remove this workaround when the stable Forge line fixes its declaration surface.
- `.node-version` and CI pin the exact Node `24.19.0` development baseline. The package `engines` field accepts the maintained Node 24 line as a compatibility range; it is not the reproducible CI selector.
- GitHub Actions uses the current stable `actions/checkout` `7.0.1` and `actions/setup-node` `7.0.0` releases, pinned by full commit SHA rather than mutable major tags. Sources: [checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) and [setup-node 7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0).

## Required T1 validation

The Forge/Vite combination is not accepted solely because development compilation works. T1 must smoke-test both `electron-forge start` and `electron-forge package --platform=win32 --arch=x64` through repository scripts on Node `24.19.0`, then launch the packaged Windows artifact. Verify main, preload, and renderer bundles; production asset paths; ASAR/fuses; CSP; the custom protocol; and native-module unpacking. Record any version change here before changing manifests.

Version sources: [Node.js 24 archive](https://nodejs.org/en/download/archive/v24), [Electron releases](https://releases.electronjs.org/releases.json), and package-specific metadata from the [npm registry](https://registry.npmjs.org/).
