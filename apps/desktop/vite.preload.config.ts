import { defineConfig } from 'vite';

// See vite.main.config.ts for why the output filename is pinned explicitly with a `.cjs`
// extension. Electron's sandboxed preload scripts must be CommonJS.
export default defineConfig({
  build: {
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: 'preload.cjs',
      },
    },
  },
});
