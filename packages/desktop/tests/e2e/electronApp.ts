import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, test as base, expect } from '@playwright/test';
import {
  loadDatabaseFixture,
  rememberOpenProject,
} from '../../../../scripts/desktop-package-smoke-environment.mjs';
import { isolatedHomeEnv } from '../../../../scripts/isolated-home.mjs';
import { cleanupDirectory } from './workspaceStorageFixture.js';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const MAIN_ENTRY = join(PACKAGE_ROOT, 'dist', 'main', 'index.js');
const HEADLESS = process.env.TEXRA_DESKTOP_E2E_HEADED !== '1';

/**
 * What one test's app runs over: a temporary home, whose `~/.texra` is the
 * data root the app, its background service and a CLI share as they do for a
 * user, and the project the app opens. Electron's own profile is kept in the
 * home too (`--user-data-dir`), so nothing a launch writes leaves it.
 */
export interface Profile {
  readonly home: string;
  readonly dataRoot: string;
  readonly workspacePath: string;
}

/** A fresh profile with an empty project; {@link removeProfile} ends it. */
export function createProfile(): Profile {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'texra-e2e-home-')));
  const workspacePath = join(home, 'project');
  mkdirSync(workspacePath);
  // Chromium on Linux reads the certificates it trusts from the user's NSS
  // database; that is the machine's configuration, not TeXRA data, so the
  // home keeps it (a TLS proxy's root, say, for a page a test loads).
  const trust = join(homedir(), '.pki');
  if (existsSync(trust)) symlinkSync(trust, join(home, '.pki'));
  return { home, dataRoot: join(home, '.texra'), workspacePath };
}

/** The background services of `dataRoot`: each listens on a socket named
 *  by its process id. */
async function servicePids(dataRoot: string): Promise<number[]> {
  const { servicePaths } = await loadDatabaseFixture();
  const { socketDirectory } = servicePaths(dataRoot);
  return (existsSync(socketDirectory) ? readdirSync(socketDirectory) : [])
    .map((name) => /^serve-(\d+)\.sock$/.exec(name)?.[1])
    .filter((pid) => pid !== undefined)
    .map((pid) => Number.parseInt(pid, 10))
    .filter(alive);
}

/**
 * Stop the background services of `dataRoot`, which outlive the app that
 * started them; a test that writes the store a service holds stops it first.
 */
export async function stopServices(dataRoot: string): Promise<void> {
  const pids = await servicePids(dataRoot);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  await expect.poll(() => pids.filter(alive), { timeout: 30_000 }).toEqual([]);
}

/** Whether process `pid` still runs. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop the profile's services and remove its home. */
export async function removeProfile(profile: Profile): Promise<void> {
  await stopServices(profile.dataRoot);
  cleanupDirectory(profile.home);
}

export interface LaunchedApp {
  readonly app: ElectronApplication;
  /** The app's main process, which outlives Playwright's handle on it. */
  readonly process: ChildProcess;
  readonly page: Page;
  readonly profile: Profile;
  /** The renderer's uncaught errors, which a test's teardown expects none of. */
  readonly rendererErrors: string[];
}

type Launch = (env?: Record<string, string>) => Promise<LaunchedApp>;

/**
 * The runner owns each app's lifetime: `profile` is the test's own,
 * `launch` starts the app over it (again after a close, for a relaunch), and
 * `launched` is the first launch. After the test every app still open is
 * closed, the renderers must have thrown nothing, and the profile's services
 * stop. `launchEnv` adds environment variables to every launch of a file
 * (`test.use({ launchEnv })`).
 */
export const test = base.extend<{
  launchEnv: Record<string, string>;
  profile: Profile;
  launch: Launch;
  launched: LaunchedApp;
}>({
  launchEnv: [{}, { option: true }],
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads the fixture's dependencies from this pattern.
  profile: async ({}, use) => {
    const profile = createProfile();
    try {
      await use(profile);
    } finally {
      await removeProfile(profile);
    }
  },
  launch: async ({ profile, launchEnv }, use) => {
    const apps: LaunchedApp[] = [];
    await use(async (env = {}) => {
      const launched = await launchTexraApp(profile, { ...launchEnv, ...env });
      apps.push(launched);
      return launched;
    });
    for (const launched of apps) await closeTexraApp(launched);
    expect(apps.flatMap((launched) => launched.rendererErrors)).toEqual([]);
  },
  launched: async ({ launch }, use) => {
    await use(await launch());
  },
});

export { expect };

/** `locator`'s bounding box, which a visible element has. */
export async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error(`${String(locator)} has no bounding box`);
  return found;
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
export async function findWorkspaceStoragePath(
  profile: Profile,
): Promise<string> {
  const fixture = await loadDatabaseFixture();
  return fixture.resolveWorkspaceStoragePath(
    profile.dataRoot,
    realpathSync(profile.workspacePath),
  );
}

/**
 * Launch the TeXRA Electron desktop app over `profile`, opening its project.
 *
 * Assumes the renderer + main bundles are already built (`pnpm --filter
 * @texra/desktop build` or the individual `build:main`/`build:preload`/
 * `build:renderer` scripts). The harness intentionally does NOT rebuild on
 * every test — that would blow the per-suite budget.
 */
export async function launchTexraApp(
  profile: Profile,
  env: Record<string, string> = {},
): Promise<LaunchedApp> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `Electron main bundle missing at ${MAIN_ENTRY}. ` +
        `Run \`pnpm --filter @texra/desktop build\` first.`,
    );
  }

  // The app reopens what the profile remembers; there is no launch flag.
  await rememberOpenProject(profile.dataRoot, profile.workspacePath);
  const app = await electron.launch({
    args: [
      MAIN_ENTRY,
      `--user-data-dir=${join(profile.home, 'electron-profile')}`,
    ],
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      ...isolatedHomeEnv(profile.home),
      // Test runs never report usage (and never raise the first-run notice).
      TEXRA_NO_TELEMETRY: '1',
      NODE_ENV: 'production',
      ...env,
      // Electron's offscreen renderer keeps native windows, Dock and focus
      // out of the developer's session. Playwright's headless option alone
      // does not control an application launched through _electron.
      TEXRA_DESKTOP_HEADLESS: HEADLESS ? '1' : '0',
    },
  });

  const page = await app.firstWindow();
  const rendererErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.error(`[desktop renderer] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    console.error('[desktop renderer]', error);
    rendererErrors.push(error.message);
  });
  // Resize the native window, not Playwright's renderer viewport. Calling
  // page.setViewportSize() installs a fixed emulation viewport in Electron:
  // the BrowserWindow can then grow while CSS `vw`/`vh` stay frozen at the
  // original size, leaving a dead white region on the right and bottom.
  // Keeping the canonical capture size at the BrowserWindow layer preserves
  // deterministic screenshots while exercising real desktop resize behavior.
  const launched = {
    app,
    process: app.process(),
    page,
    profile,
    rendererErrors,
  };
  await resizeWindow(launched, 1280, 800);
  // Wait for the actual renderer, independently of native window visibility.
  await page.waitForSelector('#app', { state: 'attached' });
  await page.waitForFunction(
    () => document.body.dataset.desktopReady === 'true',
    undefined,
    { timeout: 20_000 },
  );
  // Every launch is the service's client, as a user's is; the service it
  // starts listens before the test begins, so the teardown finds it.
  if (process.platform !== 'win32')
    await expect
      .poll(async () => (await servicePids(profile.dataRoot)).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
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
  return launched;
}

/** Set the native window's content size (see {@link launchTexraApp}). */
export async function resizeWindow(
  { app }: LaunchedApp,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows().at(0);
      if (!window) throw new Error('TeXRA window was not found.');
      window.setContentSize(size.width, size.height);
    },
    { width, height },
  );
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

/**
 * Close `launched`'s app, unless it has already exited, and wait for its
 * process to exit. Playwright's own close also waits for every process that
 * holds the app's pipes to it, and the background service the app started
 * inherits them, so that close finishes only once the profile's services stop
 * ({@link removeProfile}).
 */
export async function closeTexraApp(launched: LaunchedApp): Promise<void> {
  const child = launched.process;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  try {
    if (HEADLESS) await assertOffscreen(launched.app);
  } finally {
    launched.app.close().catch((error: unknown) => {
      console.error('[desktop e2e] close', error);
    });
    await exited;
  }
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
