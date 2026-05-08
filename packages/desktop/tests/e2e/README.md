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

On first launch the macOS keychain may prompt for `safeStorage` access. In a
headless Playwright run that prompt is denied automatically, which crashes
startup with `Cannot read properties of undefined (reading 'kind')` from the
secrets layer. As a result the committed baseline screenshots currently show
the **"TeXRA could not start"** fatal-startup screen rather than the real
launcher / progress / settings views.

Two paths to real screenshots:

1. **Interactive bootstrap.** Run the desktop app once normally, accept the
   keychain prompt, then run `pnpm --filter @texra/desktop test:e2e`. Once
   keychain access is granted, subsequent headless runs reuse the credential
   without prompting and the screenshots will reflect the actual UI.
2. **Stub the secrets backend.** A follow-up PR should add an in-memory
   `secrets` adapter selected when `TEXRA_DISABLE_KEYCHAIN=1` is set. The
   harness already exports that env var; the platform layer just needs to
   honor it. Until then, the baseline screenshots prove the harness wiring
   but are not visually meaningful.

If a particular test starts hanging on the keychain prompt, mark it with
`test.skip()` and open a follow-up — the harness can ship without perfect
baselines.
