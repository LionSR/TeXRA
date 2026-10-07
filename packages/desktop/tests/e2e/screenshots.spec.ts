import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type TestInfo } from '@playwright/test';

import {
  closeTexraApp,
  chooseDesktopTheme,
  dismissOnboarding,
  launchTexraApp,
  openDesktopAppearance,
  showLauncher,
  type LaunchedApp,
} from './electronApp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_SCREENSHOTS_DIR = join(HERE, '__screenshots__');
const UPDATE_BASELINE_SCREENSHOTS =
  process.env.TEXRA_UPDATE_E2E_SCREENSHOTS === '1';

let launched: LaunchedApp;

function getScreenshotPath(testInfo: TestInfo, fileName: string): string {
  if (UPDATE_BASELINE_SCREENSHOTS) {
    return join(BASELINE_SCREENSHOTS_DIR, fileName);
  }

  return testInfo.outputPath(fileName);
}

test.beforeAll(async () => {
  launched = await launchTexraApp();
});

test.afterAll(async () => {
  if (launched) {
    await closeTexraApp(launched);
  }
});

/** Count the actionable entries of the command palette, or -1 when unopened. */
async function commandPaletteEntryCount(): Promise<number> {
  return launched.page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '.desktop-command-palette',
    );
    if (!dialog) return -1;
    return dialog.querySelectorAll(
      'button, [role="option"], .desktop-command-palette-entry',
    ).length;
  });
}

async function commandPaletteIsClosed(): Promise<boolean> {
  return launched.page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '.desktop-command-palette',
    );
    return dialog == null || dialog.getAttribute('open') == null;
  });
}

// No startup dialog: a fresh profile opens on the conversation, where the
// "Connect a model" card stands in for the launcher until a credential
// exists (a profile whose environment already carries a key opens on the
// launcher).
test('first-run screenshot', async () => {
  await launched.page.waitForFunction(
    () => {
      const root = document.querySelector('progress-app')?.shadowRoot;
      return (
        root?.querySelector('onboarding-welcome-card, session-composer') != null
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  expect(
    await launched.page.locator('wa-dialog.desktop-onboarding').count(),
  ).toBe(0);
  for (const theme of ['light', 'dark'] as const) {
    await launched.page.emulateMedia({ colorScheme: theme });
    await expect(launched.page.locator('body')).toHaveClass(
      new RegExp(`vscode-${theme}`),
    );
    await launched.page.evaluate(() => document.fonts.ready);
    await launched.page.screenshot({
      path: getScreenshotPath(
        test.info(),
        theme === 'light' ? 'startup.png' : 'startup-dark.png',
      ),
      animations: 'disabled',
      fullPage: false,
    });
  }
  await dismissOnboarding(launched.page);
});

test('command palette opens and dismisses', async () => {
  await showLauncher(launched);
  await expect(launched.page.locator('.shell-conversation')).toBeVisible();
  await launched.page
    .locator('.shell-sidebar-primary .shell-sidebar-action')
    .filter({ hasText: 'Commands' })
    .click();
  await expect.poll(commandPaletteEntryCount).toBeGreaterThan(0);
  await launched.page.screenshot({
    path: test.info().outputPath('command-palette-dark.png'),
    animations: 'disabled',
  });
  await launched.page.keyboard.press('Escape');
  await expect.poll(commandPaletteIsClosed).toBe(true);
});

// The vertical settings navigation must remain operable by keyboard, and
// its controls must stay reachable when the native window shrinks.
test('settings navigation and appearance across window sizes', async () => {
  const { app, page } = launched;
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator('body')).toHaveClass(
      new RegExp(`vscode-${theme}`),
    );
    await page.screenshot({
      path: test.info().outputPath(`launcher-${theme}.png`),
      animations: 'disabled',
    });
    await page
      .locator('.shell-sidebar-footer .shell-sidebar-action')
      .filter({ hasText: 'Settings' })
      .click();
    const settings = page.locator('wa-dialog.desktop-settings-overlay');
    await expect(settings).toHaveJSProperty('open', true);
    const pages = settings.getByRole('tablist', { name: 'Settings pages' });
    await expect(pages).toHaveAttribute('aria-orientation', 'vertical');
    const tabs = pages.getByRole('tab');
    await expect(tabs.first()).toHaveAccessibleName('General');
    for (const tab of await tabs.all()) {
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const name = await tab.getAttribute('data-panel');
      await page.screenshot({
        path: test.info().outputPath(`settings-${name}-${theme}.png`),
        animations: 'disabled',
      });
    }
    await tabs.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    // Crossing a visual group heading still advances to the next page.
    await page.keyboard.press('ArrowDown');
    await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(960, 640);
    });
    await expect(settings.getByRole('tabpanel')).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`settings-compact-${theme}.png`),
      animations: 'disabled',
    });
    await settings.locator('.desktop-settings-close').click();
    await expect(settings).toHaveJSProperty('open', false);
    await page.screenshot({
      path: test.info().outputPath(`launcher-compact-${theme}.png`),
      animations: 'disabled',
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800);
    });
  }
});

test('appearance settings override the system and remember the choice', async () => {
  const { page } = launched;
  async function chooseTheme(theme: 'light' | 'dark' | 'system') {
    await chooseDesktopTheme(page, theme);
  }
  async function expectTheme(theme: 'light' | 'dark') {
    await expect(page.locator('body')).toHaveClass(
      new RegExp(`vscode-${theme}`),
    );
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
  }

  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme('light');
  const lightBackground = await page
    .locator('.shell-frame')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  await chooseTheme('dark');
  await expectTheme('dark');
  await expect(page.locator('.shell-frame')).not.toHaveCSS(
    'background-color',
    lightBackground,
  );
  // Selecting the current choice must retain a valid single selection.
  await chooseTheme('dark');
  await page.reload();
  await expectTheme('dark');
  const themeControl = await openDesktopAppearance(page);
  await expect(themeControl).toHaveJSProperty('value', 'dark');
  await themeControl.click();
  await page.screenshot({
    path: test.info().outputPath('appearance-theme-dark.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await page.locator('.desktop-settings-close').click();

  await page.emulateMedia({ colorScheme: 'dark' });
  await chooseTheme('light');
  await expectTheme('light');
  await expect(page.locator('.shell-frame')).toHaveCSS(
    'background-color',
    lightBackground,
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme('light');
  await page.screenshot({
    path: test.info().outputPath('theme-override-light.png'),
    animations: 'disabled',
  });
  await chooseTheme('system');
  await expectTheme('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme('light');
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.locator('body')).toHaveClass(/vscode-high-contrast/);
  await page.emulateMedia({ forcedColors: 'none', colorScheme: 'dark' });
  await expectTheme('dark');
});
