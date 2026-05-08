# Desktop e2e screenshot harness

A small Playwright suite that launches the TeXRA Electron app and captures
screenshots of the three primary shell routes. Used for visual sanity-checking
during UI work.

## Run

```bash
# Build first (the suite does not rebuild per-test).
pnpm --filter @texra/desktop build

# Run the suite. Generates PNGs in tests/e2e/__screenshots__/.
pnpm --filter @texra/desktop test:e2e
```

The suite is intentionally separate from `vitest` and is **not** wired into
the default `npm test` flow.

## Baselines

Baseline PNGs in `tests/e2e/__screenshots__/` are committed to the repo so
reviewers have a fixed reference. To refresh after a deliberate UI change:

1. Run `pnpm --filter @texra/desktop test:e2e`.
2. Inspect the diffs in `tests/e2e/test-results/` (gitignored).
3. Copy the new captures into `__screenshots__/` and commit.

`tests/e2e/test-results/` (Playwright's per-run artifact dump) is gitignored.

## Workspace folder

Each launch passes `--texra-workspace <tmpdir>` so the app doesn't pop the
"open folder" dialog. Pass `workspacePath` to `launchTexraApp()` if a
specific layout is required.

## macOS keychain caveat

The harness sets `TEXRA_DISABLE_KEYCHAIN=1` (see `electronApp.ts`) which the
secrets layer (`packages/desktop/src/main/platform/electronSecrets.ts`)
honors by skipping `safeStorage` entirely:

- `getSecretStorageMode()` returns `'unavailable'` without touching
  `safeStorage`, so the launch-time keychain prewarm never prompts.
- `ElectronSecrets.get()` returns `undefined` for any persisted key (env-var
  API key overrides still work).
- `ElectronSecrets.set()` silently no-ops with a one-time `console.warn`.

This keeps headless Playwright runs from blocking on the macOS keychain
prompt and crashing startup with the
`Cannot read properties of undefined (reading 'kind')` fallback. To run
locally exactly as CI does, prefix your invocation:

```bash
TEXRA_DISABLE_KEYCHAIN=1 pnpm --filter @texra/desktop test:e2e
```

Persisted secret reads/writes are disabled in this mode by design — it is a
test-harness shim only and not exposed as a user-facing toggle.
