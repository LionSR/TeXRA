# Desktop e2e screenshot harness

The functional suite drives the real Electron app with isolated profiles and
offscreen rendering. Windows stay hidden and cannot take focus; Dock badges
and OS notifications are disabled. The harness checks these conditions at
launch and shutdown. No desktop switching is needed.

The separate appearance project captures startup, the launcher, command
palette, and settings in light/dark mode at normal and narrow widths.
Run it when reviewing a visual change, rather than in every development loop.

## Run

```bash
# Build first (the suite does not rebuild per-test).
pnpm --filter @texra/desktop build

# Run the suite. Generates ignored PNG artifacts under tests/e2e/test-results/.
pnpm --filter @texra/desktop test:e2e

# Run only the affected file during development, still offscreen.
pnpm --filter @texra/desktop test:e2e tests/e2e/workspaceTabs.spec.ts

# Explicit visual review, also offscreen.
pnpm --filter @texra/desktop test:appearance

# Check Vite cold startup, editor loading, and document reload offscreen.
pnpm --filter @texra/desktop test:dev
```

`TEXRA_DESKTOP_E2E_HEADED=1` explicitly opts into visible windows for manual
debugging. Do not use that mode in routine checks. On a Linux host without a
display server, run Electron under `xvfb-run`; offscreen rendering does not
remove Electron's platform display-server dependency.

The suite is intentionally separate from `vitest` and is **not** wired into
the default `npm test` flow.

## Baselines

The startup PNGs in `tests/e2e/__screenshots__/` are committed
so reviewers have a fixed reference of what a fresh profile sees. Nothing
diffs against it; normal test runs never modify it. To refresh after a
deliberate UI change:

1. Run
   `TEXRA_UPDATE_E2E_SCREENSHOTS=1 pnpm --filter @texra/desktop test:appearance`.
2. Inspect the changed baselines.
3. Commit them only when the visual change is intentional.

`tests/e2e/test-results/` (Playwright's per-run artifact dump) is gitignored.

## Workspace folder

Each launch records a temporary project through the production SQLite owner
in the isolated profile, so the app opens that project. Pass `workspacePath` to `launchTexraApp()` if a
specific layout is required.

## Cross-package imports

Playwright's ESM loader cannot resolve a relative `.js` import of a TS file
from `packages/harness/src/shared/...` (it sees the `.js` suffix and treats the resolved
module as CommonJS, then fails on named exports). The shared fixture loader in
`scripts/desktop-package-smoke-environment.mjs` bundles the production database
and project-record operations with esbuild. Both E2E launches and the packaged
application smoke use that loader, without duplicating SQL or persisted schemas.

## Saved keys

The app keeps saved keys in the shared owner-only `secrets/` folder under its
data root, which the harness points at a throwaway user-data directory
(`TEXRA_DESKTOP_E2E_USER_DATA_PATH`), so no run touches the keychain or the
developer's own keys.
