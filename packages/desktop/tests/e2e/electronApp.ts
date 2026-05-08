import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const MAIN_ENTRY = join(PACKAGE_ROOT, 'dist', 'main', 'index.js');

export interface LaunchOptions {
  /**
   * Workspace path to inject via `--texra-workspace`. If omitted, a fresh
   * temp directory is created so the app does not pop the "open folder"
   * dialog at startup.
   */
  workspacePath?: string;
  /**
   * Extra environment variables to pass to the Electron child process.
   * Useful for stubbing out keychain access.
   */
  env?: Record<string, string>;
}

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  workspacePath: string;
}

/**
 * Launch the TeXRA Electron desktop app for e2e testing.
 *
 * Assumes the renderer + main bundles are already built (`pnpm --filter
 * @texra/desktop build` or the individual `build:main`/`build:preload`/
 * `build:renderer` scripts). The harness intentionally does NOT rebuild on
 * every test — that would blow the per-suite budget.
 *
 * On macOS the first launch may trigger a keychain prompt because the app
 * touches `safeStorage`. Set `TEXRA_DISABLE_KEYCHAIN=1` (handled by the app
 * platform layer) or run the suite under a CI keychain to avoid the freeze.
 */
export async function launchTexraApp(
  options: LaunchOptions = {},
): Promise<LaunchedApp> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `Electron main bundle missing at ${MAIN_ENTRY}. ` +
        `Run \`pnpm --filter @texra/desktop build\` first.`,
    );
  }

  const workspacePath =
    options.workspacePath ?? mkdtempSync(join(tmpdir(), 'texra-e2e-'));

  const app = await electron.launch({
    args: [MAIN_ENTRY, '--texra-workspace', workspacePath],
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      // Hint to platform/secrets layer to avoid the macOS keychain prompt.
      TEXRA_DISABLE_KEYCHAIN: '1',
      NODE_ENV: 'production',
      ...options.env,
    },
  });

  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  // Wait for the renderer root to mount before tests interact.
  await page.waitForSelector('#app', { state: 'attached' });
  return { app, page, workspacePath };
}

export async function closeTexraApp(launched: LaunchedApp): Promise<void> {
  await launched.app.close();
}
