import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
    ],
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    passWithNoTests: false,
  },
});
