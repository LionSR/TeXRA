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
 * The committed baseline under tests/e2e/__screenshots__/ is a reference for
 * reviewers, refreshed with TEXRA_UPDATE_E2E_SCREENSHOTS=1 and never diffed;
 * each run's captures land in tests/e2e/test-results/ (gitignored).
 */
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './tests/e2e/test-results',
  // Offscreen apps use isolated profiles. Serialize resource-heavy integration
  // journeys; visual matrices are a separate, explicitly requested project.
  workers: 1,
  fullyParallel: false,
  projects: [
    {
      name: 'desktop',
      testIgnore: ['**/screenshots.spec.ts', '**/devStartup.spec.ts'],
    },
    { name: 'appearance', testMatch: '**/screenshots.spec.ts' },
    { name: 'development', testMatch: '**/devStartup.spec.ts' },
  ],
  // Generous timeout: cold Electron launch + IPC bring-up can take a while.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    headless: true,
    // Baseline viewport for committed screenshots. Individual tests may
    // override via `page.setViewportSize()`.
    viewport: { width: 1280, height: 800 },
  },
});
