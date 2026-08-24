/**
 * Single source of truth for npm packages that ship a compiled native `.node` addon and are ever
 * consumed from the Main process — currently just `uiohook-napi` (via
 * `packages/windows-media/src/ptt-hotkey-listener.ts`'s deliberately lazy `import('uiohook-napi')`,
 * see that file's own doc comment for why the import itself is dynamic) and its own runtime
 * dependency `node-gyp-build` (which `uiohook-napi`'s compiled `dist/index.js` itself `require()`s
 * to locate the right prebuilt binary for the current platform/arch/runtime/ABI).
 *
 * T13.4 QA fix — this list drives two otherwise-easy-to-desync places, both of which a real
 * `electron-forge package` run proved matter for a native addon specifically:
 *
 * 1. `vite.main.config.ts` marks every package here `external` in Rollup's `build.rollupOptions`, so
 *    Rollup leaves the real `require`/dynamic `import()` of the package alone instead of inlining its
 *    compiled JS into `.vite/build/main.cjs` (or a chunk next to it). Inlining is wrong for a package
 *    whose own code computes a native-binary path from its own `__dirname` at *module* load
 *    time (`node-gyp-build(path.join(__dirname, '..'))` — verified directly against `uiohook-napi`'s
 *    real compiled `dist/index.js`): once inlined, that `__dirname` resolves to somewhere under
 *    `apps/desktop/.vite/build/`, not the package's own real `node_modules/<name>/` directory, so the
 *    prebuilt-binary lookup fails deterministically in every real packaged/built app, even though the
 *    exact same code works when run directly via plain `node`/`ts-node` (confirmed live during this
 *    fix — inlining is a Rollup/Vite-specific hazard, not a defect in the native package itself).
 *
 * 2. `forge.config.ts` copies every package here (whole-directory, not just their compiled entry
 *    point) into the packaged app's own `node_modules`, and unpacks their `.node` binaries out of
 *    `app.asar` — both needed only because of (1): once a package is `external` rather than inlined,
 *    the packaged app's own `require(name)` at runtime only succeeds if a real copy of that package
 *    (with its own `prebuilds/`/`build/` directory intact) actually exists on disk next to the
 *    compiled Main bundle, which `@electron-forge/plugin-vite`'s own default `packagerConfig.ignore`
 *    does not provide (that default keeps only the `.vite/` output directory and ignores `node_modules`
 *    entirely, which is correct for every *other* dependency here, since those are otherwise always
 *    fully inlined by Rollup and need no runtime `node_modules` presence at all).
 *
 * Add a new entry here (and only here) the next time a Main-process-only dependency needs a real
 * compiled native addon — do not repeat this list separately in `vite.main.config.ts` or
 * `forge.config.ts`, which would risk the two drifting apart (e.g. externalizing a package in Rollup
 * without also arranging for it to actually be copied/unpacked into the packaged app, silently
 * reproducing this exact class of bug for a different dependency).
 */
export const nativeMainProcessPackages = ['uiohook-napi', 'node-gyp-build'] as const;
