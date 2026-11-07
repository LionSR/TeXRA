import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestInfo } from '@playwright/test';

import {
  chooseDesktopTheme,
  closeTexraApp,
  createProfile,
  dismissOnboarding,
  expect,
  launchTexraApp,
  openDesktopAppearance,
  removeProfile,
  resizeWindow,
  showLauncher,
  test,
  type LaunchedApp,
  type Profile,
} from './electronApp.js';

// Visual review: captures of the startup, launcher, command palette and
// settings surfaces. Their behaviour is asserted in `trajectories.spec.ts`,
// which CI runs; this project runs on request.

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_SCREENSHOTS_DIR = join(HERE, '__screenshots__');
const UPDATE_BASELINE_SCREENSHOTS =
  process.env.TEXRA_UPDATE_E2E_SCREENSHOTS === '1';

let profile: Profile;
let launched: LaunchedApp;

function getScreenshotPath(testInfo: TestInfo, fileName: string): string {
  if (UPDATE_BASELINE_SCREENSHOTS) {
    return join(BASELINE_SCREENSHOTS_DIR, fileName);
  }

  return testInfo.outputPath(fileName);
}

test.beforeAll(async () => {
  profile = createProfile();
  launched = await launchTexraApp(profile);
});

// A failed beforeAll leaves either unset; its own error is the one reported.
test.afterAll(async () => {
  if (launched) await closeTexraApp(launched);
  if (profile) await removeProfile(profile);
  if (launched) expect(launched.rendererErrors).toEqual([]);
});

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

test('command palette', async () => {
  await showLauncher(launched);
  await expect(launched.page.locator('.shell-conversation')).toBeVisible();
  await launched.page
    .locator('.shell-sidebar-primary .shell-sidebar-action')
    .filter({ hasText: 'Commands' })
    .click();
  await expect(
    launched.page.locator('.desktop-command-palette'),
  ).toHaveAttribute('open');
  await launched.page.screenshot({
    path: test.info().outputPath('command-palette-dark.png'),
    animations: 'disabled',
  });
  await launched.page.keyboard.press('Escape');
});

test('settings across themes and window sizes', async () => {
  const { page } = launched;
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
    const tabs = settings
      .getByRole('tablist', { name: 'Settings pages' })
      .getByRole('tab');
    for (const tab of await tabs.all()) {
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const name = await tab.getAttribute('data-panel');
      await page.screenshot({
        path: test.info().outputPath(`settings-${name}-${theme}.png`),
        animations: 'disabled',
      });
      if (name === 'agents') {
        await settings.locator('[data-section="skills"]').click();
        await expect(
          settings.getByRole('textbox', { name: 'Search skills', exact: true }),
        ).toBeVisible();
        await page.screenshot({
          path: test.info().outputPath(`settings-skills-${theme}.png`),
          animations: 'disabled',
        });
        await settings.locator('[data-section="library"]').click();
      }
      if (name === 'plugins') {
        await settings
          .getByRole('button', { name: 'Goal Mode', exact: true })
          .click();
        await expect(
          settings.getByRole('switch', {
            name: 'Available to agents',
            exact: true,
          }),
        ).toBeVisible();
        await page.screenshot({
          path: test.info().outputPath(`settings-goal-plugin-${theme}.png`),
          animations: 'disabled',
        });
      }
    }
    await resizeWindow(launched, 960, 640);
    await expect(settings.getByRole('tabpanel')).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`settings-compact-${theme}.png`),
      animations: 'disabled',
    });
    await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
    const catalog = settings.locator('agent-selection-panel');
    await expect(
      catalog.getByRole('textbox', { name: 'Search agents', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`settings-agents-compact-${theme}.png`),
      animations: 'disabled',
    });
    await settings.getByRole('tab', { name: 'Plugins', exact: true }).click();
    await settings
      .getByRole('button', { name: 'Goal Mode', exact: true })
      .click();
    await expect(
      settings.getByRole('switch', {
        name: 'Available to agents',
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`settings-goal-plugin-compact-${theme}.png`),
      animations: 'disabled',
    });
    await settings
      .getByRole('tab', { name: 'Models', exact: true })
      .first()
      .click();
    await settings.locator('[data-section="subscriptions"]').click();
    const subscription = settings.locator('subscription-section').first();
    // Presentation fixture only: exercise the reported usage-card boundaries
    // without credentials, provider requests, or changes to account state.
    await subscription.evaluate((element) => {
      const now = Date.now();
      Object.assign(element, {
        auth: {
          provider: 'chatgpt',
          signedIn: true,
          email: 'researcher@example.org',
          preferSubscription: true,
        },
        now,
        usage: {
          providerName: 'ChatGPT',
          planName: 'Plus',
          state: 'available',
          fetchedAt: now,
          windows: [
            {
              name: '5-hour',
              percentUsed: 1,
              percentRemaining: 99,
              resetAt: now + 34 * 60_000,
            },
            {
              name: '7-day',
              percentUsed: 0,
              percentRemaining: 100,
              resetAt: now + 6 * 86_400_000,
            },
          ],
        },
      });
    });
    await expect(subscription.locator('.usage-plan')).toContainText('Plus');
    await page.screenshot({
      path: test.info().outputPath(`settings-subscription-${theme}.png`),
      animations: 'disabled',
    });
    await settings.locator('.desktop-settings-close').click();
    await expect(settings).toHaveJSProperty('open', false);
    await page.screenshot({
      path: test.info().outputPath(`launcher-compact-${theme}.png`),
      animations: 'disabled',
    });
    await resizeWindow(launched, 1280, 800);
  }
});

test('appearance settings', async () => {
  const { page } = launched;
  for (const theme of ['dark', 'light'] as const) {
    await chooseDesktopTheme(page, theme);
    const themeControl = await openDesktopAppearance(page);
    await themeControl.click();
    await page.screenshot({
      path: test.info().outputPath(`appearance-theme-${theme}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await page.locator('.desktop-settings-close').click();
  }
  await chooseDesktopTheme(page, 'system');
});
