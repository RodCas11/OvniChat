import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

import { nativeMainProcessPackages } from './native-main-dependencies.js';

// T12 — packages the compiled Windows process-loopback native helper alongside the app via
// `packagerConfig.extraResource`, not `asar`'s `unpack` glob. An earlier version of this config
// used `asar.unpack`, on the (reasonable-looking but wrong) assumption that
// `@disco-voador/windows-media`'s files would end up somewhere inside the packaged
// `node_modules` tree for `unpack` to find. A real `electron-forge package` run during this task
// disproved that: `@electron-forge/plugin-vite`'s Rollup build inlines every workspace package's
// JS directly into `main.cjs`/`preload.cjs` (see `vite.main.config.ts`), so the packaged `app.asar`
// ends up with **no** `node_modules/@disco-voador/*` tree at all — there is nothing for `asarUnpack`
// to unpack, and `main/process-audio.ts`'s dev-mode `require.resolve('@disco-voador/windows-media/
// package.json')` path resolution would throw at runtime in a packaged build. `extraResource` copies
// the helper directly into the packaged app's `resources` directory (outside the asar entirely, so
// no unpack step is needed at all) — `process-audio.ts`'s `resolveHelperExecutablePath` reads it
// back via `process.resourcesPath` specifically when `app.isPackaged`. This path is computed here at
// package time from this config file's own real on-disk location (`import.meta.url`), never from
// anything relative to a `node_modules` layout — the same "resolve relative to windows-media's own
// real location, never assume a hardcoded/node_modules path" discipline the dev-mode resolution
// path already follows.
const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const processLoopbackHelperExePath = path.join(
  desktopDir,
  '..',
  '..',
  'packages',
  'windows-media',
  'native',
  'process-loopback-helper',
  'build',
  'process-loopback-helper.exe',
);

// T13.4 QA fix — where `nativeMainProcessPackages`' *real* npm package directories actually live on
// disk, so `packageAfterCopy` below can copy them into the packaged app. This workspace's pnpm
// `nodeLinker: hoisted` setting (`.npmrc`) hoists ordinary third-party npm dependencies to a single
// `node_modules` at the monorepo root only — verified directly (`apps/desktop/node_modules` itself
// contains only Vite's own scratch directories and this workspace's own `@disco-voador/*` symlinks,
// never `uiohook-napi`/`node-gyp-build`) — so `@electron/packager`'s own copy, which is rooted at
// `apps/desktop` (`packagerConfig`'s implicit `dir`, i.e. this app's own directory), never has these
// two packages anywhere in the tree it walks in the first place; no `ignore`/`asar.unpack` glob can
// "keep" a path that was never a candidate to copy at all. This was found live: an earlier version of
// this fix tried exactly that (a custom `packagerConfig.ignore` allow-listing
// `/node_modules/<name>` prefixes) and a real `electron-forge package` run's own `app.asar` still
// came out with a completely empty `node_modules` — proving the packages were never reachable from
// `apps/desktop`'s own tree to begin with, not merely filtered out.
const repoRootNodeModules = path.join(desktopDir, '..', '..', 'node_modules');

// T13.5 — the authoritative Chantivo Windows icon, packaged straight from a copy under this app's
// own `resources/` directory (never regenerated/approximated — see `docs/BRANDING.md`). Copied here
// rather than referenced directly from `src/assets/brand/` because `packagerConfig.icon` needs a
// stable on-disk path outside anything Vite/Rollup touches; `src/assets/brand/` remains the single
// Renderer-facing source of truth for every other brand asset (the mark/wordmark components import
// straight from there). Electron Packager appends the correct per-platform extension itself when
// given an extensionless base path — `chantivo.ico` is picked up automatically on win32.
const chantivoIconBasePath = path.join(desktopDir, 'resources', 'chantivo');

const forgeConfig: ForgeConfig = {
  // T15 — first real Windows installer for this repo (previously `package` only produced a raw
  // packaged directory, no `.exe`/installer output at all). `MakerSquirrel` wraps `electron-
  // winstaller`, which itself wraps the real Squirrel.Windows toolchain (`vendor/Squirrel.exe`,
  // bundled inside `electron-winstaller` itself — no separate install/download step).
  //
  // `title`, `description`, and `exe` are left to `electron-winstaller`'s own `usePackageJson`-driven
  // inference (on by default) rather than duplicated here, verified directly against a real
  // `electron-forge make` run and `@electron-forge/maker-squirrel`'s own `MakerSquirrel.js` (not just
  // its `.d.ts`, which only documents `electron-winstaller`'s options, not which ones Forge's own
  // wrapper already fills in before handing off):
  //   - `exe`/`title` default to Forge's own computed `appName`, which itself is `filenamify(
  //     packagerConfig.name || packageJSON.productName || packageJSON.name)` — since this app's
  //     `package.json` sets `productName: "Chantivo"`, `appName` resolves to `"Chantivo"`, exactly
  //     matching the real packaged executable's own name (`out/Chantivo-win32-x64/Chantivo.exe`,
  //     confirmed by a real `electron-forge package` run). No `exe`/`title` override is needed.
  //   - `description` defaults from this `package.json`'s own `description` field, which is already
  //     accurate.
  // `name` and `authors` cannot be left to their defaults:
  //   - `name`: `MakerSquirrel.js`'s own default (not `electron-winstaller`'s) is
  //     `packageJSON.name.replace(/-/g, '_')` — this app's real, scoped npm package name
  //     (`@disco-voador/desktop`) contains `@` and `/`, neither of which hyphen-replacement touches,
  //     which would hand `electron-winstaller` an invalid NuGet package ID. Set explicitly to the
  //     public product name instead — internal-namespace-free, matching `docs/BRANDING.md`'s
  //     "Internal namespace policy" (the public product name is the only thing this installer should
  //     ever expose).
  //   - `authors`: NuGet's `.nuspec` schema requires a non-empty `Authors` field; a real
  //     `electron-forge make` run left unset failed outright (`nuspec.exe`: "Authors is required.")
  //     because this `package.json` has no `author` field for `usePackageJson` to infer from, and
  //     none exists anywhere else in this monorepo either (`license: "UNLICENSED"`, no `LICENSE`
  //     file, no company/org entity). Rather than fabricate a company name or expose an individual
  //     contributor's personal name in shipped installer metadata, this uses the same public product
  //     name as `name`/`title` — the only identity this installer should surface at all.
  //
  // `setupIcon` is Squirrel's own icon option for `Setup.exe` and the generated uninstaller —
  // distinct from `packagerConfig.icon` above, which only covers the packaged app's own `.exe` icon.
  // Left unset, Squirrel falls back to a generic default icon for both.
  //
  // Auto-update is deliberately NOT wired: no `autoUpdater` calls, no `remoteReleases`/update-feed
  // URL. There is no public release-hosting endpoint yet (a separate, not-yet-done T15 slice); wiring
  // an update feed with nothing behind it would be dead/misleading configuration. Revisit once real
  // release hosting exists.
  makers: [
    new MakerSquirrel({
      name: 'Chantivo',
      authors: 'Chantivo',
      setupIcon: `${chantivoIconBasePath}.ico`,
    }),
  ],
  packagerConfig: {
    icon: chantivoIconBasePath,
    // `asar.unpack` (rather than a plain `asar: true`) is required specifically because
    // `nativeMainProcessPackages` are no longer inlined by Rollup (see `vite.main.config.ts`): their
    // real `.node` binaries get copied into the packaged app by the `packageAfterCopy` hook below,
    // and Node/Electron cannot `dlopen` a native addon from inside a sealed `asar` archive — a real,
    // general Electron constraint, not specific to `uiohook-napi`. `**/*.node` is intentionally
    // broader than just `uiohook-napi`'s own prebuild, so any future native-addon dependency this app
    // adds is unpacked automatically without a matching edit here. Verified directly against a real
    // `electron-forge package` run: without this, no `app.asar.unpacked` directory was produced at
    // all (T13.4 QA's own diagnosis, confirmed live during this fix), which — even after the Rollup
    // externalization and `packageAfterCopy` fixes alone — would still leave `node-gyp-build`'s own
    // `require(path.join(dir, 'prebuilds', ...))` lookup unable to actually load the binary it
    // correctly locates by path (Node cannot `dlopen` from inside `app.asar`).
    asar: { unpack: '**/*.node' },
    // Statically linked via `/MT` (per `packages/windows-media/native/process-loopback-helper/`'s
    // own build), so no companion DLLs of its own also need copying. The Chantivo `.ico` rides along
    // in the same array so it is also reachable at a known, packaged-mode-only path
    // (`process.resourcesPath`/`chantivo.ico`) for `window-options.ts`'s own dev/packaged
    // `BrowserWindow` icon resolution — Forge's default app-directory copy is not a place to rely on
    // for a stable runtime path (unlike the packaged executable's own embedded icon resource, which
    // `icon` above already handles independently of this).
    extraResource: [processLoopbackHelperExePath, chantivoIconBasePath + '.ico'],
  },
  hooks: {
    // T13.4 QA fix — runs once per packaged platform/arch, after Electron Forge's own copy of
    // `apps/desktop` into `buildPath` (which never contained these packages to begin with — see
    // `repoRootNodeModules`'s own doc comment) but before that same packaging run's `asar` step seals
    // `buildPath` into `app.asar`, so files added here are still included. Copies each of
    // `nativeMainProcessPackages`' real, whole package directories (prebuilds, compiled JS, and
    // `package.json` included — `node-gyp-build`'s own lookup reads the target package's
    // `package.json`, and needs its compiled `prebuilds/<platform>-<arch>/*.node` binary) from this
    // monorepo's single hoisted root `node_modules` into the packaged app's own `node_modules`, so the
    // externalized (see `vite.main.config.ts`) `require`/dynamic `import()` calls the compiled Main
    // bundle makes for them resolve to a real, complete copy at runtime exactly the way they already
    // do in this same repository's own dev-mode `node_modules` today.
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      for (const name of nativeMainProcessPackages) {
        await fsPromises.cp(
          path.join(repoRootNodeModules, name),
          path.join(buildPath, 'node_modules', name),
          { recursive: true },
        );
      }
    },
  },
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  rebuildConfig: {},
};

export default forgeConfig;
