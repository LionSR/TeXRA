import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type TestInfo } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  showLauncher,
  setSettingsTab,
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

test('startup team chooser screenshot', async ({}, testInfo) => {
  const panel = launched.page.locator('.desktop-startup-panel');
  await expect(panel).toBeVisible();
  await expect(
    panel.locator('wa-checkbox').filter({
      hasText: "Don't show this at startup",
    }),
  ).toBeVisible();
  await launched.page.screenshot({
    path: getScreenshotPath(testInfo, 'startup.png'),
    fullPage: false,
  });
  await dismissOnboarding(launched.page);
});

test('launcher screenshot', async ({}, testInfo) => {
  await showLauncher(launched);
  await launched.page.screenshot({
    path: getScreenshotPath(testInfo, 'launcher.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});

test('settings screenshot', async ({}, testInfo) => {
  // Open the Multi-Agent settings page — the most visually rich area.
  await setSettingsTab(launched, 4, 'multi-agent');
  await launched.page.screenshot({
    path: getScreenshotPath(testInfo, 'settings.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});

test('command palette opens and dismisses', async () => {
  await showLauncher(launched);
  // A prior screenshot can leave Settings in the workbench. Hide the workbench
  // so this check exercises the conversation-header command affordance.
  const closeWorkbench = launched.page.locator('.task-workbench-close');
  if (await closeWorkbench.isVisible()) {
    await closeWorkbench.click();
  }
  await expect(launched.page.locator('.task-conversation')).toBeVisible();
  await launched.page
    .locator('.task-header-button[aria-label="Show Commands"]')
    .click();
  await expect.poll(commandPaletteEntryCount).toBeGreaterThan(0);
  await launched.page.keyboard.press('Escape');
  await expect.poll(commandPaletteIsClosed).toBe(true);
});
