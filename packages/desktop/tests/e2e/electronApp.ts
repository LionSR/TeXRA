import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import {
  loadDatabaseFixture,
  rememberOpenProject,
} from '../../../../scripts/desktop-package-smoke-environment.mjs';
import { cleanupDirectory } from './workspaceStorageFixture.js';
import type { ElectronApplication, Page } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const MAIN_ENTRY = join(PACKAGE_ROOT, 'dist', 'main', 'index.js');
const HEADLESS = process.env.TEXRA_DESKTOP_E2E_HEADED !== '1';

interface LaunchOptions {
  /**
   * Workspace folder the app opens at launch, seeded into the profile's
   * remembered projects (there is no launch flag; the app reopens what it
   * remembers). If omitted, a fresh temp directory is created so the app
   * shows a project rather than the empty state at startup.
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
  userDataPath: string;
  /**
   * True when `launchTexraApp()` allocated a temp workspace itself (caller
   * did not supply one). `closeTexraApp()` cleans this up so repeated CI
   * runs do not litter the system temp directory.
   */
  ownsWorkspace: boolean;
  /** True when `launchTexraApp()` allocated an isolated desktop profile. */
  ownsUserData: boolean;
}

export async function openDesktopAppearance(page: Page) {
  await page
    .locator('.shell-sidebar-footer .shell-sidebar-action')
    .filter({ hasText: 'Settings' })
    .click();
  const settings = page.locator('wa-dialog.desktop-settings-overlay');
  await expect(settings).toHaveJSProperty('open', true);
  await settings.getByRole('tab', { name: 'General', exact: true }).click();
  await settings.locator('[data-section="appearance"]').click();
  const select = settings.locator('#desktopTheme');
  await expect(select).toBeVisible();
  return select;
}

export async function chooseDesktopTheme(
  page: Page,
  theme: 'light' | 'dark' | 'system',
) {
  const select = await openDesktopAppearance(page);
  await select.click();
  await select.locator(`wa-option[value="${theme}"]`).click();
  await expect(select).toHaveJSProperty('value', theme);
  await page.locator('.desktop-settings-close').click();
  await expect(
    page.locator('wa-dialog.desktop-settings-overlay'),
  ).toHaveJSProperty('open', false);
}

/** Resolve project storage through the production path function in the fixture bundle. */
export async function findWorkspaceStoragePath(input: {
  userDataPath: string;
  workspacePath: string;
}): Promise<string> {
  const fixture = await loadDatabaseFixture(input.userDataPath);
  return fixture.resolveWorkspaceStoragePath(
    input.userDataPath,
    realpathSync(input.workspacePath),
  );
}

/**
 * Launch the TeXRA Electron desktop app for e2e testing.
 *
 * Assumes the renderer + main bundles are already built (`pnpm --filter
 * @texra/desktop build` or the individual `build:main`/`build:preload`/
 * `build:renderer` scripts). The harness intentionally does NOT rebuild on
 * every test — that would blow the per-suite budget.
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
  const ownsUserData = options.userDataPath === undefined;
  const userDataPath =
    options.userDataPath ?? mkdtempSync(join(tmpdir(), 'texra-e2e-user-data-'));

  await rememberOpenProject(userDataPath, workspacePath);
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      // Test runs never report usage (and never raise the first-run notice).
      TEXRA_NO_TELEMETRY: '1',
      TEXRA_DESKTOP_E2E_USER_DATA_PATH: userDataPath,
      NODE_ENV: 'production',
      ...options.env,
      // Electron's offscreen renderer keeps native windows, Dock and focus
      // out of the developer's session. Playwright's headless option alone
      // does not control an application launched through _electron.
      TEXRA_DESKTOP_HEADLESS: HEADLESS ? '1' : '0',
    },
  });

  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.error(`[desktop renderer] ${message.text()}`);
  });
  page.on('pageerror', (error) => console.error('[desktop renderer]', error));
  // Resize the native window, not Playwright's renderer viewport. Calling
  // page.setViewportSize() installs a fixed emulation viewport in Electron:
  // the BrowserWindow can then grow while CSS `vw`/`vh` stay frozen at the
  // original size, leaving a dead white region on the right and bottom.
  // Keeping the canonical capture size at the BrowserWindow layer preserves
  // deterministic screenshots while exercising real desktop resize behavior.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().at(0);
    if (!window) throw new Error('TeXRA window was not found.');
    window.setContentSize(1280, 800);
  });
  // Wait for the actual renderer, independently of native window visibility.
  await page.waitForSelector('#app', { state: 'attached' });
  await page.waitForFunction(
    () => document.body.dataset.desktopReady === 'true',
    undefined,
    { timeout: 20_000 },
  );
  if (HEADLESS) await assertOffscreen(app);
  else
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().at(0)?.isVisible() ?? false,
        ),
      )
      .toBe(true);
  return {
    app,
    page,
    workspacePath,
    userDataPath,
    ownsWorkspace,
    ownsUserData,
  };
}

async function assertOffscreen(app: ElectronApplication): Promise<void> {
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused(),
      offscreen: window.webContents.isOffscreen(),
    })),
  );
  for (const window of windows)
    expect(window).toEqual({ visible: false, focused: false, offscreen: true });
}

export async function closeTexraApp(launched: LaunchedApp): Promise<void> {
  try {
    if (HEADLESS) await assertOffscreen(launched.app);
  } finally {
    await launched.app.close();
  }
  // Clean up only auto-allocated directories. Caller-supplied workspace and
  // profile paths may be reused across relaunches and remain caller-owned.
  if (launched.ownsWorkspace) cleanupDirectory(launched.workspacePath);
  if (launched.ownsUserData) cleanupDirectory(launched.userDataPath);
}

export async function dismissOnboarding(page: Page): Promise<void> {
  // A fresh profile shows the "Connect a model" card inside <progress-app>'s
  // shadow tree; without skipping it, E2E tests exercise onboarding instead
  // of the launcher and can miss task-composer regressions.
  await page
    .waitForFunction(
      () => {
        const root = document.querySelector('progress-app')?.shadowRoot;
        return (
          root?.querySelector('onboarding-welcome-card, session-composer') !=
          null
        );
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  const skip = page.locator('onboarding-welcome-card #onboardingSkipButton');
  const canSkip = await skip.isVisible().catch(() => false);
  if (canSkip) {
    // Programmatic activation: the card may sit under a transient overlay.
    await skip.evaluate((button: HTMLElement) => button.click());
    await skip.waitFor({ state: 'detached', timeout: 5000 });
  }

  // The launcher can render before main.ts has finished registering its
  // desktop shell listeners. Wait for the renderer's explicit readiness
  // marker so the first command after onboarding is never dropped.
  await page.waitForFunction(
    () => document.body.dataset.desktopReady === 'true',
    undefined,
    { timeout: 10_000 },
  );
}

export async function showLauncher(launched: LaunchedApp): Promise<void> {
  await launched.page.locator('#shellNewTask').click();
  await launched.page.waitForFunction(
    () => {
      return (
        document
          .querySelector('progress-app')
          ?.shadowRoot?.querySelector('session-composer.launch-composer') !=
        null
      );
    },
    undefined,
    { timeout: 5000 },
  );
}

type DesktopWorkbenchKind = 'logs';

export async function openWorkbench(
  launched: LaunchedApp,
  kind: DesktopWorkbenchKind,
): Promise<void> {
  await launched.page.evaluate((nextKind) => {
    window.postMessage(
      { command: 'desktop:openWorkbench', kind: nextKind },
      '*',
    );
  }, kind);
  await launched.page.waitForFunction(
    (targetKind) => {
      const tab = document.querySelector<HTMLElement>(
        `.shell-dock-tab[data-kind="${targetKind}"]`,
      );
      const surface = document.querySelector<HTMLElement>(
        `[data-desktop-view="${targetKind}"]`,
      );
      return tab != null && surface != null;
    },
    kind,
    { timeout: 5000 },
  );
}

/**
 * Open the Settings popup and activate the tab named `tab` (its wire panel name,
 * which is also the nav button's `data-panel` value), waiting until that page
 * button reports `data-active="true"` so callers never race the previous
 * tab's render.
 */
export async function setSettingsTab(
  launched: LaunchedApp,
  tab: string,
): Promise<void> {
  await launched.page.evaluate(() => {
    window.postMessage({ command: 'desktop:openSettings' }, '*');
  });
  await launched.page.waitForFunction(
    () =>
      document.querySelector(
        'wa-dialog.desktop-settings-overlay settings-app',
      ) != null,
    undefined,
    { timeout: 5000 },
  );
  await launched.page.evaluate((panel) => {
    window.postMessage({ command: 'setTab', tab: panel }, '*');
  }, tab);
  await launched.page.waitForFunction(
    (activePanel) => {
      const settingsApp = document.querySelector('settings-app');
      const root = settingsApp?.shadowRoot;
      if (!root) return false;
      return (
        root.querySelector(
          `.settings-page-button[data-panel="${activePanel}"][data-active="true"]`,
        ) != null
      );
    },
    tab,
    { timeout: 10_000 },
  );
}
