import { defineConfig } from 'vite';

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
  },
});
