# TypeScript 7 upgrade — running notes

Status: **implemented on branch `feat/typescript-7`, all checks green** · Last updated: 2026-08-04

Moved from `module: commonjs` + `moduleResolution: bundler` (TS 6 transitional
combo) to full **`module: nodenext` + `moduleResolution: nodenext`** — the
compatibility layer is gone. Every paths alias now uses three variants:
`*`, `*.ts`, and `*/index.ts` (bare first to keep bundlers from hitting
`*/index.ts` on files). `esModuleInterop` / `sourceMap` / heap flags removed
as TS7 defaults. Extension tsconfig now extends root; desktop/trace-viewer
chain simplified via `paths.json extends root`. CI `NODE_OPTIONS` memory
flags deleted — TS7's Go compiler doesn't use the Node heap.
`.mts`/`.js` under both `nodenext` and `bundler`-mode configs).

Accumulating doc for the TeXRA workspace's move from TypeScript 6 to
TypeScript 7 (the Go-native compiler). Facts below were verified against the
linked sources and against dry-run compiler probes on this repo.

## TL;DR

- TypeScript 7.0.2 was released 2026-07-08 (`typescript@latest` = 7.0.2).
  ~8-12x faster full builds, lower memory. Editor support via LSP; VS Code
  uses the "TypeScript Native Preview" extension.
- TS 7.0 ships **no JS compiler API**. A new (different) API is expected in
  TS 7.1 (`typescript@next` = 7.1.0-dev nightlies).
- **typescript-eslint does not and cannot support TS 7 yet** (maintainers,
  2026-07-08/09). The official solution for API-dependent tooling is the
  side-by-side npm-alias setup below. Track
  [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)
  (locked; labeled `blocked by external API`).
- Repo-specific dry runs show the config migration is **config-only, zero
  source edits**: `moduleResolution: nodenext` + drop `baseUrl` + three-value
  `paths` variants (`*.ts`, `*/index.ts`, bare `*`) typechecks clean on this
  codebase.

## Verified facts (with sources)

### TypeScript 7.0 release

- [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
  (2026-07-08). Ships as the normal `typescript` npm package; `npx tsc` is the
  native compiler. Measured speedups: vscode 11.9x, sentry 8.9x, bluesky
  8.7x, playwright 8.7x (default `--checkers 4`; more with `--checkers 8`).
  New flags: `--checkers N`, `--builders N` (project-reference parallelism),
  `--singleThreaded`.
- npm dist-tags (verified 2026-08-04): `latest` = 7.0.2, `next` =
  7.1.0-dev.*. Nightly builds moved from `@typescript/native-preview` to
  `typescript@next`.
- Editor: VS Code support via the dedicated
  [TypeScript Native Preview extension](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview).
  This is **independent of the repo migration** — any dev can install it
  today and get the TS 7 language service against this workspace as-is.

### No JS API in 7.0 → the side-by-side recipe

From the announcement ("Running Side-by-Side with TypeScript 6.0"): TS 7.0
has no API; TS 7.1 will ship a new, different one. Microsoft published
`@typescript/typescript6` (provides a `tsc6` binary + re-exports the TS 6.0
API). Recommended package.json pattern (works with pnpm aliases):

```jsonc
{
  "devDependencies": {
    // Tools that import the compiler API keep resolving TS 6:
    "typescript": "npm:@typescript/typescript6@^6.0.2",
    // TS 7's tsc for all build/typecheck scripts:
    "@typescript/native": "npm:typescript@^7.0.2",
  },
}
```

After this, `npx tsc` = TS 7 and `npx tsc6` = TS 6. Note that with
`typescript@7` installed directly, `require("typescript")` exposes only a
stub — anything importing the API breaks loudly, which is why the alias must
be in place first (observed in
[#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518)).

### typescript-eslint: current solution

- Even the latest release (8.66.0, verified 2026-08-04) pins
  `typescript: ">=4.8.4 <6.1.0"` — TS 7 is excluded by design.
- Maintainer answers on "TypeScript 7.0.2 Support"
  ([#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518)):
  _"typescript-eslint isn't compatible with TS 7 at this time, because there
  is no TS 7 API at this time… You'll just want to set up typescript-eslint
  to use TS 6, for example as described in [the side-by-side section of the
  announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0)."_
- Tracking issue [#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)
  (Use TS 7 for type information) is locked by bradzacher (2026-07-09):
  _"For now there is nothing we can do to support tsgo / TSv7… there is
  currently no stable JS API."_ Historical blockers noted there beyond the
  missing API: ESLint's lack of async parser support
  ([eslint#15475](https://github.com/eslint/eslint/issues/15475)) and rules'
  dependence on the JS-land AST — so full TS-7-powered linting is a
  typescript-eslint v9-scale effort, not a patch release.
- **Consequence for us:** lint keeps running on the TS 6 API via the alias
  above, indefinitely until TS 7.1 + a typescript-eslint release adopting the
  new API. Lint-time type semantics stay TS 6; compile-time moves to TS 7.
  Divergence risk is small (TS 7 is a faithful port) but nonzero — if lint
  and `tsc` ever disagree, trust `tsc`.
- typescript-eslint's own repo already typechecks with TS 7 while linting
  with TS 6 ([PR #12601](https://github.com/typescript-eslint/typescript-eslint/pull/12601)) —
  a working reference for the same split.

### Config migration guidance (from the TS 6.0 announcement)

[Announcing TypeScript 6.0](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/)
is the transition release; everything deprecated in 6.0 is **removed** in
7.0 (`ignoreDeprecations: "6.0"` only buys time on 6.x).

- **`baseUrl` deprecated.** Recommended fix: delete it and add the prefix to
  each `paths` value (`"app/*"` → `"./src/app/*"`). Only if `baseUrl` was
  genuinely used as a module lookup root (rare), add a catch-all mapping
  `"*": ["./src/*"]` first in `paths`.
- **`moduleResolution: "node"` (node10) deprecated.** Recommended targets:
  `nodenext` (Node apps) or `bundler` (bundled apps). **New in TS 6.0:
  `--module commonjs` may be combined with `--moduleResolution bundler` —
  called out as "often the most suitable upgrade path"** for projects not
  ready to change `module`.
- Up-front adjustments that bite silently: set an explicit `types` array
  (we already do), set explicit `rootDir` if you relied on inference.
- `--stableTypeOrdering` (TS 6.x) makes union-ordering match TS 7 — useful
  if error snapshots/text differ between the two compilers.
- An experimental `ts5to6` codemod (auto-adjusts `baseUrl`/`rootDir`) is
  mentioned in the announcement, but as of 2026-08-04 it is not on npm and
  github.com/microsoft/ts5to6 is 404 — verify availability before relying on
  it. Our fallback (manual config edit) is small anyway.

## Repo-specific findings (probed 2026-08-04)

Current state: root devDep `typescript: ^6.0.3`; `ignoreDeprecations: "6.0"`
set in root, extension, and trace-viewer tsconfigs. All emit is esbuild/vite
**except** `packages/agent` declaration emit
(`tsc -p tsconfig.build.json`, already `NodeNext`) +
`packages/agent/scripts/rewrite-declaration-aliases.mjs`.

TS-API consumers that must keep resolving TS 6 via the alias:

- `typescript-eslint` / `@typescript-eslint/*` (peer range excludes 7).
- `src/test-kernel/architecture/*.vitest.ts` (6 files, `ts.createSourceFile`).
- `scripts/aliasUtils.mjs` (`import ts from 'typescript'`).
- knip and vitest have **no** typescript peer dependency — unaffected.

Deprecated options in use: `baseUrl` (root `tsconfig.json`,
`packages/extension/tsconfig.json`, `packages/desktop/tsconfig.paths.json`)
and `moduleResolution: "node"` (root + extension). Both stop functioning in
7.0.

Dry-run probes (ran the real TS 6 compiler against TS-7-style configs):

| Probe config                                                                                                        | Errors | Notes                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `nodenext`, no `baseUrl`, `./`-prefixed paths                                                                       | 22     | all extensionless lazy `await import('@alias/…')` in 5 files (dynamic import resolves in ESM mode) |
| same + `*.ts` / `*/index.ts` path variants (like `tsconfig.build.json`)                                             | **0**  | config-only fix                                                                                    |
| `commonjs` kept + `moduleResolution: bundler`, no `baseUrl`, `./`-prefixed paths (incl. `./node_modules/…` entries) | **0**  | simplest: no path variants needed                                                                  |

**Recommended repo path:** switch root + extension configs to
`module: nodenext` + `moduleResolution: nodenext`, drop `baseUrl`, use
three-variant `paths` values (`*.ts`, `*/index.ts`, bare `*`) so both
`nodenext` (extensionless dynamic imports) and `bundler`-mode configs
(explicit-extension `.mts`/`.js` imports) resolve cleanly. Update
`scripts/aliasUtils.mjs` builders to pick the bare `*` variant for vite
aliases and to not double-add variants in `deriveBuildPaths`. Drop
`ignoreDeprecations`.

## Package-by-package (probed/audited 2026-08-04)

- **root `tsconfig.json`** — `commonjs` + `bundler` probe: **0 errors**.
- **`packages/extension`** (VS Code ext) — standalone tsconfig with the same
  two deprecated options; same probe (keep `commonjs`, `bundler`, `./`
  prefixes): **0 errors**. Runtime emit is esbuild
  (`esbuild.config.mjs`, `tsconfig: './tsconfig.json'` — esbuild reads only
  `paths`, supports paths-without-baseUrl since 0.18; installed 0.28) and
  vite for webviews (aliases from `scripts/aliases.mjs`, tsconfig-independent).
  vsce packaging doesn't touch `tsc`. **Runtime unaffected; only the
  typecheck gets faster.**
- **`packages/desktop`** (Electron) — best prepared package: all four
  configs (main `nodenext`, preload `nodenext`, renderer + base `bundler`)
  extend `tsconfig.paths.json`, whose `baseUrl: "../.."` is the only
  deprecated option. Fix: delete it and prefix every path value with
  `./../../`. Emit is esbuild (main/preload, CJS) + vite (renderer) —
  untouched. Electron/packaging tooling (`@electron/asar`, electron-builder
  scripts) never invokes `tsc`.
- **`packages/cli`** (Ink) — tsconfig **extends the root config**, so it
  inherits the migration automatically; already `esnext`+`bundler` with an
  explicit `rootDir` (matches TS 6 guidance). Ink 7.1.1 is ESM-only, ships
  types via `exports`, peers only on react/@types/react — compiler-agnostic.
  The React-compiler smoke test uses Babel
  (`@babel/preset-typescript` strips types) — independent of `tsc`.
  Bundle is esbuild with its own alias map.
- **`packages/agent`** — `build:types` (`tsc -p tsconfig.build.json`,
  emitDeclarationOnly) is the repo's only real `tsc` emit. Already NodeNext;
  verify output + `packages/agent/scripts/rewrite-declaration-aliases.mjs` under TS 7.
- **`packages/trace-viewer`** — `bundler` already; only stale
  `ignoreDeprecations` to drop.

## Dependency audit (2026-08-04)

Every package.json swept for TS-coupled tooling. **None found** beyond:

- `typescript: ^6.0.3` devDep in **6 packages** (root, agent, cli, desktop,
  extension, trace-viewer) — all must switch to the alias pair together
  (pnpm isolates per-package bins; `tsc` in a package script resolves to
  that package's dep).
- typescript-eslint stack (TS 6 via alias, per above) and the 3 direct
  API-usage sites (ratchet tests, `aliasUtils.mjs`).

Explicitly absent: ts-node, tsx, ts-jest, ts-loader, ts-morph, typedoc,
api-extractor, tsup, tsc-alias, tsconfig-paths (runtime), ts-patch,
vite-tsconfig-paths. `vitest.config.mjs` has no typecheck mode (esbuild
transform only). All runtime dependencies (ink, react, zod, AI SDKs, …)
interact with TS only via shipped `.d.ts`, consumed under
`skipLibCheck: true` — TS 7 is a behavior-faithful port, so risk here is
negligible. Note: ink carries a pnpm patch (version-pinned, unrelated to
the compiler).

## Migration checklist (implemented on branch `feat/typescript-7`)

Results: `tsc` = 7.0.2 / `tsc6` = 6.0.3 via pnpm aliases · full `nodenext`
(no compatibility layers) · all `tsc` invocations pinned at `--checkers 8` ·
typecheck (7 configs, 21s), lint, test (8459 passed), compile:fast, agent
build (689 declarations validated), all repo checks, prettier — green.

- [x] package.json (**×6**: root, agent, cli, desktop, extension,
      trace-viewer): `"typescript": "npm:@typescript/typescript6@^6.0.2"` +
      `"@typescript/native": "npm:typescript@^7.0.2"`; lockfile refreshed;
      pnpm created `tsc` + `tsc6` shims in every package `.bin`.
- [x] Update `scripts/aliasUtils.mjs` (emit `./` prefixes).
      `deriveExtensionPaths` emits `./` / `./../../`; `deriveDesktopPaths`
      is no longer identity — every value gets `./../../`.
      `sync:tsconfig-paths` + `check:tsconfig-paths` pass.
- [x] Migrate `tsconfig.json`, `packages/extension/tsconfig.json` (bundler
      resolution, no `baseUrl`/`ignoreDeprecations`);
      `packages/desktop/tsconfig.paths.json` (`./../../` prefixes);
      dropped stale `ignoreDeprecations` in desktop/trace-viewer;
      `tsconfig.build.json` paths `./`-prefixed.
- [x] `npm run typecheck` (7 configs) on TS 7 — 24s total, 0 errors.
- [x] `npm run compile:fast` — esbuild/vite alias resolution works with
      baseUrl-free tsconfigs.
- [x] `npm run lint` — passes on the TS 6 API alias.
- [x] `npm test` — passes; three fixtures that pin the generated paths
      format were updated (AliasMapGeneration, BuildAliasConfig,
      subsystemEdgeRatchet `./`-strip).
- [x] Verify `packages/agent` declaration emit +
      `packages/agent/scripts/rewrite-declaration-aliases.mjs` under TS 7 —
      validated 689 declarations / 70 external packages.
- [x] CI: pinned `--checkers 8` in every `tsc` script for reproducibility
      (TS 7 `--checkers` can produce rare order-dependent results).
- [x] Optional: `--stableTypeOrdering` — not needed; we typecheck with TS 7
      and have no snapshot tests comparing TS 6 vs TS 7 ordering.

### Surprises found during implementation (2026-08-04)

- `packages/agent/scripts/rewrite-declaration-aliases.mjs` and
  `validate-artifacts.mjs` filtered node_modules-pointing aliases with
  `startsWith('node_modules/')`, which stops matching once paths values are
  `./`-prefixed — would have broken the agent build. Both now strip a
  leading `./` first.
- Desktop previously relied on `baseUrl: "../.."` making its paths identical
  to root's; without `baseUrl` they must be `./../../`-prefixed (the sync
  generator now encodes this).
- Prettier is non-idempotent on the gitignored minified trace-viewer bundle
  produced by `compile:fast` — pre-existing flake, unrelated; a second
  `prettier --write` settles `format:check`.
- `.vscode/extensions.json` now recommends `TypeScriptTeam.native-preview`
  (editor-side TS 7; the workspace `typescript` package remains TS 6 for
  API tooling).

## Watch list

- TS 7.1 (new JS API) — `typescript@next`.
- typescript-eslint adoption of the TS 7 API — issue #10940; likely a v9.
- VS Code Native Preview extension updates (editor-side).
- `ts5to6` codemod publication status.

## Sources

- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
- https://github.com/typescript-eslint/typescript-eslint/issues/12518
- https://github.com/typescript-eslint/typescript-eslint/issues/10940
- https://github.com/typescript-eslint/typescript-eslint/pull/12601
- https://github.com/eslint/eslint/issues/15475
- https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview
