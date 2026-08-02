# Desktop e2e screenshot harness

A small Playwright suite that launches the TeXRA Electron app and captures
screenshots of the three primary shell routes. Used for visual sanity-checking
during UI work.

## Run

```bash
# Build first (the suite does not rebuild per-test).
pnpm --filter @texra/desktop build

# Run the suite. Generates ignored PNG artifacts under tests/e2e/test-results/.
pnpm --filter @texra/desktop test:e2e
```

The suite is intentionally separate from `vitest` and is **not** wired into
the default `npm test` flow.

## Baselines

Baseline PNGs in `tests/e2e/__screenshots__/` are committed to the repo so
reviewers have a fixed reference. Normal test runs never modify them. To
refresh after a deliberate UI change:

1. Run
   `TEXRA_UPDATE_E2E_SCREENSHOTS=1 pnpm --filter @texra/desktop test:e2e`.
2. Inspect the changed baselines.
3. Commit them only when the visual change is intentional.

`tests/e2e/test-results/` (Playwright's per-run artifact dump) is gitignored.

## Workspace folder

Each launch passes `--texra-workspace-path <tmpdir>` so the app doesn't pop the
"open folder" dialog. Pass `workspacePath` to `launchTexraApp()` if a
specific layout is required.

## Cross-package imports

Playwright's ESM loader cannot resolve a relative `.js` import of a TS file
from `src/shared/...` (it sees the `.js` suffix and treats the resolved
module as CommonJS, then fails on named exports). To stay safe, prefer
inlining constants the suite needs from the shared schemas with a comment
pointing back at the source of truth.

## macOS keychain caveat

The harness sets `TEXRA_DISABLE_KEYCHAIN=1` (see `electronApp.ts`) which the
secrets layer (`packages/desktop/src/main/platform/electronSecrets.ts`)
honors by skipping `safeStorage` entirely:

- `getSecretStorageMode()` returns `'unavailable'` without touching
  `safeStorage`.
- `ElectronSecrets.get()` returns `undefined` for any persisted key (env-var
  API key overrides still work).
- `ElectronSecrets.set()` silently no-ops with a one-time `console.warn`.

This keeps headless Playwright runs from blocking on the macOS keychain
prompt and preserves the renderer bootstrap fallback for
`Cannot read properties of undefined (reading 'kind')`. To run locally exactly
as CI does, prefix your invocation:

```bash
TEXRA_DISABLE_KEYCHAIN=1 pnpm --filter @texra/desktop test:e2e
```

Persisted secret reads/writes are disabled in this mode by design — it is a
test-harness shim only and not exposed as a user-facing toggle.
