import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the TeXRA Electron desktop app.
 *
 * The suite is intentionally a separate scope from the existing Vitest tests:
 * it launches a real Electron process via `playwright._electron.launch()` and
 * captures screenshots used as visual baselines.
 *
 * Run via:
 *   pnpm --filter @texra/desktop test:e2e
 *
 * Baseline screenshots committed under tests/e2e/__screenshots__/ are diffed
 * against captures produced during the test run; failed comparisons land in
 * tests/e2e/test-results/ (gitignored).
 */
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './tests/e2e/test-results',
  // Single Electron app at a time keeps macOS keychain prompts predictable.
  workers: 1,
  fullyParallel: false,
  // Generous timeout: cold Electron launch + IPC bring-up can take a while.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // Baseline viewport for committed screenshots. Individual tests may
    // override via `page.setViewportSize()`.
    viewport: { width: 1280, height: 800 },
  },
});
