import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // T13.1 — `@vitejs/plugin-react` is otherwise only a dependency of `apps/desktop` (its real
  // Renderer build, see `apps/desktop/vite.renderer.config.ts`); adding it here too gives this
  // repo's first `@testing-library/react` component tests (`tests/desktop/*.test.tsx`, scoped via
  // their own per-file `// @vitest-environment jsdom` pragma) the exact same JSX-to-`react/jsx-
  // runtime` transform the real app uses, rather than a hand-rolled esbuild `jsx` option that could
  // silently drift from it. Every existing Main-process `.test.ts` file is untouched by this — it
  // only affects how `.tsx` files are transformed, and this repo has none outside `apps/desktop`'s
  // own Renderer source and these new tests.
  plugins: [react()],
  resolve: {
    // Workspace packages resolve through node_modules (-> their built "dist/") for real
    // consumers, but that would make a test importing the same package by source path (as this
    // repo's tests otherwise always do, per-workspace) load a *second*, distinct module instance
    // - breaking `instanceof` checks across the two. Aliasing to source here makes every import
    // of these packages resolve to the exact same module under the test runner, and also means
    // tests don't require a prior `pnpm build` of these packages to run.
    alias: [
      {
        find: '@disco-voador/config',
        replacement: path.resolve(__dirname, 'packages/config/src/index.ts'),
      },
      {
        find: '@disco-voador/protocol',
        replacement: path.resolve(__dirname, 'packages/protocol/src/index.ts'),
      },
      {
        find: '@disco-voador/identity',
        replacement: path.resolve(__dirname, 'packages/identity/src/index.ts'),
      },
      {
        find: '@disco-voador/rtc-core',
        replacement: path.resolve(__dirname, 'packages/rtc-core/src/index.ts'),
      },
      {
        find: '@disco-voador/media-core',
        replacement: path.resolve(__dirname, 'packages/media-core/src/index.ts'),
      },
      {
        find: '@disco-voador/windows-media',
        replacement: path.resolve(__dirname, 'packages/windows-media/src/index.ts'),
      },
      {
        // Unlike other services/* workspaces (imported by relative path in tests, per convention),
        // @disco-voador/realtime is now also imported as a real package dependency by
        // services/dedicated-server (T8) — aliased for the same reason the packages/* entries
        // above are: so a test doesn't need a prior `pnpm build` of it to run.
        find: '@disco-voador/realtime',
        replacement: path.resolve(__dirname, 'services/realtime/src/index.ts'),
      },
      {
        find: '@disco-voador/shared',
        replacement: path.resolve(__dirname, 'packages/shared/src/index.ts'),
      },
    ],
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'tests/**/*.test.mjs'],
    passWithNoTests: false,
  },
});
