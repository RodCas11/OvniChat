import { defineConfig } from 'vite';

import { nativeMainProcessPackages } from './native-main-dependencies.js';

// Forge's default output naming derives the filename from the entry's basename, and every entry
// here is `src/<process>/index.ts`, so main and preload would otherwise collide on `index.js`.
// A `.cjs` extension also makes the output CommonJS regardless of this workspace's
// `"type": "module"`, which the Vite/Rollup `cjs` output format requires.
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/main/index.ts',
      fileName: () => 'main.cjs',
      formats: ['cjs'],
    },
    rollupOptions: {
      // T13.4 QA fix — see `native-main-dependencies.ts`'s own doc comment for the full mechanism.
      // `@electron-forge/plugin-vite`'s own base config already externalizes Node builtins/`electron`
      // (mergeConfig concatenates this array with that one — verified directly against Vite's own
      // `mergeConfigRecursively`, which concatenates rather than overwrites array-valued config keys
      // like `build.rollupOptions.external`), so this only needs to add the native-addon packages
      // that must never be inlined by Rollup.
      external: [...nativeMainProcessPackages],
    },
  },
});
