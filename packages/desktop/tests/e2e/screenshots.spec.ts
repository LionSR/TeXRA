import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  setRoute,
  type LaunchedApp,
} from './electronApp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(HERE, '__screenshots__');

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchTexraApp();
});

test.afterAll(async () => {
  if (launched) {
    await closeTexraApp(launched);
  }
});

async function selectSettingsPage(
  panelName: string,
  tabIndex: number,
): Promise<void> {
  await launched.page.evaluate((index) => {
    window.postMessage({ command: 'setTab', tabIndex: index }, '*');
  }, tabIndex);
  await launched.page.waitForFunction(
    (panel) => {
      const settingsApp = document.querySelector(
        'settings-app[data-desktop-view="settings"]',
      );
      const root = settingsApp?.shadowRoot;
      if (!root) return false;
      return (
        root.querySelector(
          `.settings-page-button[data-panel="${panel}"][data-active="true"]`,
        ) != null
      );
    },
    panelName,
    { timeout: 10000 },
  );
}

test('startup team chooser screenshot', async () => {
  const panel = launched.page.locator('.desktop-startup-panel');
  await expect(panel).toBeVisible();
  await expect(
    panel.locator('wa-checkbox').filter({
      hasText: "Don't show this at startup",
    }),
  ).toBeVisible();
  await launched.page.screenshot({
    path: join(SCREENSHOTS_DIR, 'startup.png'),
    fullPage: false,
  });
  await dismissOnboarding(launched.page);
});

test('launcher screenshot', async () => {
  await setRoute(launched, 'main');
  await launched.page.screenshot({
    path: join(SCREENSHOTS_DIR, 'launcher.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});

test('progress screenshot', async () => {
  // With no active stream, the permanent task canvas stays on <main-app>.
  // Capture it with the project/task sidebar — the default progress surface.
  await setRoute(launched, 'progress');
  await launched.page.screenshot({
    path: join(SCREENSHOTS_DIR, 'progress.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});

test('settings screenshot', async () => {
  await setRoute(launched, 'settings');
  // Open the Multi-Agent settings page — the most visually rich area.
  await selectSettingsPage('multi-agent', 4);
  await launched.page.screenshot({
    path: join(SCREENSHOTS_DIR, 'settings.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});

test('command palette opens and dismisses', async () => {
  await setRoute(launched, 'main');
  // A prior screenshot can leave Settings in the workbench. Hide the workbench
  // so this check exercises the conversation-header command affordance.
  const closeWorkbench = launched.page.locator('.task-workbench-close');
  if (await closeWorkbench.isVisible()) {
    await closeWorkbench.click();
  }
  await expect(launched.page.locator('.task-conversation')).toBeVisible();
  await launched.page
    .locator('.task-header-button[aria-label="Open commands"]')
    .click();
  await launched.page.waitForFunction(
    () => {
      const dialog = document.querySelector<HTMLElement>(
        '.desktop-command-palette',
      );
      if (!dialog) return false;
      const entries = dialog.querySelectorAll(
        'button, [role="option"], .desktop-command-palette-entry',
      );
      return entries.length > 0;
    },
    undefined,
    { timeout: 5000 },
  );
  const entryCount = await launched.page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '.desktop-command-palette',
    );
    if (!dialog) return -1;
    const entries = dialog.querySelectorAll(
      'button, [role="option"], .desktop-command-palette-entry',
    );
    return entries.length;
  });
  expect(entryCount).toBeGreaterThan(0);
  await launched.page.keyboard.press('Escape');
  await launched.page.waitForFunction(
    () => {
      const dialog = document.querySelector<HTMLElement>(
        '.desktop-command-palette',
      );
      if (!dialog) return true;
      return dialog.getAttribute('open') == null;
    },
    undefined,
    { timeout: 5000 },
  );
  const closed = await launched.page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '.desktop-command-palette',
    );
    if (!dialog) return true;
    return dialog.getAttribute('open') == null;
  });
  expect(closed).toBe(true);
});
