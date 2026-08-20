import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

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

const forgeConfig: ForgeConfig = {
  makers: [],
  packagerConfig: {
    asar: true,
    // Statically linked via `/MT` (per `packages/windows-media/native/process-loopback-helper/`'s
    // own build), so no companion DLLs of its own also need copying.
    extraResource: [processLoopbackHelperExePath],
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
