import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
   * Electron user-data directory. Supplying this lets a test relaunch the
   * desktop app against the same profile so app-scoped stores persist.
   */
  userDataPath?: string;
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
  /**
   * True when `launchTexraApp()` allocated a temp workspace itself (caller
   * did not supply one). `closeTexraApp()` cleans this up so repeated CI
   * runs do not litter the system temp directory.
   */
  ownsWorkspace: boolean;
}

/**
 * Launch the TeXRA Electron desktop app for e2e testing.
 *
 * Assumes the renderer + main bundles are already built (`pnpm --filter
 * @texra/desktop build` or the individual `build:main`/`build:preload`/
 * `build:renderer` scripts). The harness intentionally does NOT rebuild on
 * every test — that would blow the per-suite budget.
 *
 * Set `TEXRA_DISABLE_KEYCHAIN=1` (handled by the app platform layer) so the
 * harness never blocks on a macOS keychain prompt while reading or writing
 * saved secrets.
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

  const ownsWorkspace = options.workspacePath === undefined;
  const workspacePath =
    options.workspacePath ?? mkdtempSync(join(tmpdir(), 'texra-e2e-'));

  const app = await electron.launch({
    args: [MAIN_ENTRY, '--texra-workspace', workspacePath],
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      // Hint to platform/secrets layer to avoid the macOS keychain prompt.
      TEXRA_DISABLE_KEYCHAIN: '1',
      ...(options.userDataPath
        ? { TEXRA_DESKTOP_E2E_USER_DATA_PATH: options.userDataPath }
        : {}),
      NODE_ENV: 'production',
      ...options.env,
    },
  });

  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 800 });
  // Wait for the renderer root to mount before tests interact.
  await page.waitForSelector('#app', { state: 'attached' });
  return { app, page, workspacePath, ownsWorkspace };
}

export async function closeTexraApp(launched: LaunchedApp): Promise<void> {
  await launched.app.close();
  // Clean up the auto-allocated temp workspace so repeated test runs do not
  // accumulate `/tmp/texra-e2e-*` directories. If the caller supplied a
  // workspace path, leave it alone — the caller owns its lifecycle.
  if (launched.ownsWorkspace) {
    try {
      rmSync(launched.workspacePath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup. A stale temp dir is preferable to a noisy
      // teardown failure that masks the real test outcome.
    }
  }
}

export async function dismissOnboarding(page: Page): Promise<void> {
  const hasDismissButton = await page
    .waitForFunction(
      () => {
        const btn = Array.from(document.querySelectorAll('wa-button')).find(
          (b) => b.textContent?.trim() === 'Got it',
        );
        return btn instanceof HTMLElement;
      },
      undefined,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);

  if (!hasDismissButton) return;

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('wa-button')).find(
      (b) => b.textContent?.trim() === 'Got it',
    );
    if (btn instanceof HTMLElement) btn.click();
  });
  await page
    .locator('wa-dialog.desktop-onboarding')
    .waitFor({ state: 'hidden', timeout: 5000 });
}
