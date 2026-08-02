import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';

import { cleanupDirectory } from './workspaceStorageFixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const MAIN_ENTRY = join(PACKAGE_ROOT, 'dist', 'main', 'index.js');

export interface LaunchOptions {
  /**
   * Workspace path to inject via `--texra-workspace-path`. If omitted, a fresh
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
  const ownsUserData = options.userDataPath === undefined;
  const userDataPath =
    options.userDataPath ?? mkdtempSync(join(tmpdir(), 'texra-e2e-user-data-'));

  const app = await electron.launch({
    args: [MAIN_ENTRY, '--texra-workspace-path', workspacePath],
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      // Hint to platform/secrets layer to avoid the macOS keychain prompt.
      TEXRA_DISABLE_KEYCHAIN: '1',
      TEXRA_DESKTOP_E2E_USER_DATA_PATH: userDataPath,
      NODE_ENV: 'production',
      ...options.env,
    },
  });

  const page = await app.firstWindow();
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
  // `firstWindow()` resolves when Electron creates BrowserWindow, before the
  // main process's did-finish-load presentation fallback necessarily runs.
  // Wait for the renderer's explicit ready marker, then assert native
  // visibility so this remains a real blank/hidden-window regression guard
  // instead of a race against the first frame.
  await page.waitForSelector('#app', { state: 'attached' });
  await page.waitForFunction(
    () => document.body.dataset.desktopReady === 'true',
    undefined,
    { timeout: 20_000 },
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const visible = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().at(0)?.isVisible() ?? false,
    );
    if (visible) {
      return {
        app,
        page,
        workspacePath,
        userDataPath,
        ownsWorkspace,
        ownsUserData,
      };
    }
    await sleep(50);
  }
  throw new Error('TeXRA window finished loading without being presented.');
}

export async function closeTexraApp(launched: LaunchedApp): Promise<void> {
  await launched.app.close();
  // Clean up only auto-allocated directories. Caller-supplied workspace and
  // profile paths may be reused across relaunches and remain caller-owned.
  if (launched.ownsWorkspace) cleanupDirectory(launched.workspacePath);
  if (launched.ownsUserData) cleanupDirectory(launched.userDataPath);
}

/**
 * Dismiss the shell's first-run startup panel when one is present. Resolves
 * without acting on profiles that never show it, so callers that only need the
 * launcher can share this step. Pass `required` when the panel is part of what
 * the test asserts, so a missing one fails here instead of silently changing
 * what the rest of the test measures.
 */
export async function dismissStartupPanel(
  page: Page,
  options: { required?: boolean } = {},
): Promise<void> {
  const waitForDismissButton = page.waitForFunction(() => {
    const panel = document.querySelector('.desktop-startup-panel');
    const btn = Array.from(panel?.querySelectorAll('wa-button') ?? []).find(
      (button) => button.textContent?.trim() === 'Skip for now',
    );
    return btn instanceof HTMLElement;
  });
  if (options.required) {
    await waitForDismissButton;
  } else if (
    !(await waitForDismissButton.then(() => true).catch(() => false))
  ) {
    return;
  }

  await page.evaluate(() => {
    const panel = document.querySelector('.desktop-startup-panel');
    const btn = Array.from(panel?.querySelectorAll('wa-button') ?? []).find(
      (button) => button.textContent?.trim() === 'Skip for now',
    );
    if (btn instanceof HTMLElement) btn.click();
  });
  await page.waitForFunction(
    () => document.querySelector('.desktop-startup-panel') == null,
    undefined,
    { timeout: 5000 },
  );
}

export async function dismissOnboarding(page: Page): Promise<void> {
  await dismissStartupPanel(page);

  // A fresh profile can also show the credential welcome card inside
  // <main-app>'s shadow tree. Skipping it is separate from dismissing the shell
  // startup panel above; without both, E2E tests exercise onboarding instead of
  // the launcher and can miss task-composer regressions.
  await page
    .waitForFunction(
      () => {
        const root = document.querySelector('main-app')?.shadowRoot;
        return (
          root?.querySelector('onboarding-welcome-card, instruction-panel') !=
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
    // Programmatic activation avoids a closing walkthrough backdrop briefly
    // intercepting the pointer between the two independent onboarding steps.
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
  await launched.page.evaluate(() => {
    window.postMessage({ command: 'desktop:showLauncher' }, '*');
  });
  await launched.page.waitForFunction(
    () => {
      const pane = document.querySelector<HTMLElement>(
        '.task-conversation-pane[data-pane="launcher"]',
      );
      return pane != null && pane.hidden === false;
    },
    undefined,
    { timeout: 5000 },
  );
}

export type DesktopWorkbenchKind = 'settings' | 'logs';

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
      const shell = document.querySelector<HTMLElement>('.task-shell');
      const tab = document.querySelector<HTMLElement>(
        `.task-workbench-tab[data-kind="${targetKind}"][data-active="true"]`,
      );
      const surface = document.querySelector<HTMLElement>(
        `[data-desktop-view="${targetKind}"]`,
      );
      return (
        shell?.dataset.workbenchOpen === 'true' &&
        tab != null &&
        surface != null
      );
    },
    kind,
    { timeout: 5000 },
  );
}

/**
 * Route to Settings and activate the tab at `tabIndex`, waiting for the
 * settings-app shadow root to mount so the target panel can be inspected.
 * Pass `panel` (its `data-panel` value) to additionally wait until that page
 * button reports `data-active="true"` — callers that assert on which panel
 * rendered should confirm this instead of racing the previous tab's render.
 */
export async function setSettingsTab(
  launched: LaunchedApp,
  tabIndex: number,
  panel?: string,
): Promise<void> {
  await openWorkbench(launched, 'settings');
  await launched.page.evaluate((idx) => {
    window.postMessage({ command: 'setTab', tabIndex: idx }, '*');
  }, tabIndex);
  await launched.page.waitForFunction(
    (activePanel) => {
      const settingsApp = document.querySelector('settings-app');
      const root = settingsApp?.shadowRoot;
      if (!root) return false;
      if (activePanel == null) return true;
      return (
        root.querySelector(
          `.settings-page-button[data-panel="${activePanel}"][data-active="true"]`,
        ) != null
      );
    },
    panel,
    { timeout: 10_000 },
  );
}
