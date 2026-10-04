# Desktop e2e screenshot harness

A small Playwright suite that launches the TeXRA Electron app, drives the
shell (projects, workbench tabs, sessions, settings persistence), and captures
the startup screen. Used for behavior checks and visual sanity-checking during
UI work.

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

The baseline PNG in `tests/e2e/__screenshots__/` (`startup.png`) is committed
so reviewers have a fixed reference of what a fresh profile sees. Nothing
diffs against it; normal test runs never modify it. To refresh after a
deliberate UI change:

1. Run
   `TEXRA_UPDATE_E2E_SCREENSHOTS=1 pnpm --filter @texra/desktop test:e2e`.
2. Inspect the changed baselines.
3. Commit them only when the visual change is intentional.

`tests/e2e/test-results/` (Playwright's per-run artifact dump) is gitignored.

## Workspace folder

Each launch records a temporary project through the production SQLite owner
in the isolated profile, so the app opens that project. Pass `workspacePath` to `launchTexraApp()` if a
specific layout is required.

## Cross-package imports

Playwright's ESM loader cannot resolve a relative `.js` import of a TS file
from `src/shared/...` (it sees the `.js` suffix and treats the resolved
module as CommonJS, then fails on named exports). The shared fixture loader in
`scripts/desktop-package-smoke-environment.mjs` bundles the production database
and project-record operations with esbuild. Both E2E launches and the packaged
application smoke use that loader, without duplicating SQL or persisted schemas.

## Saved keys

The app keeps saved keys in the shared owner-only `secrets.json` under its
data root, which the harness points at a throwaway user-data directory
(`TEXRA_DESKTOP_E2E_USER_DATA_PATH`), so no run touches the keychain or the
developer's own keys.
