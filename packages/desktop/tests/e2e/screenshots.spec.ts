import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
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

/**
 * Send a legacy `desktop:setRoute` IPC message through the task-centric shell.
 * Main and progress keep the permanent conversation surface; Settings and Logs
 * activate their corresponding right-workbench tabs.
 */
async function setRoute(
  route: 'main' | 'progress' | 'settings' | 'logs',
): Promise<void> {
  await launched.page.evaluate((next) => {
    window.postMessage({ command: 'desktop:setRoute', route: next }, '*');
  }, route);
  await launched.page.waitForFunction(
    (targetRoute) => {
      if (document.body.dataset.desktopRoute !== targetRoute) return false;
      const shell = document.querySelector<HTMLElement>('.task-shell');
      if (!shell) return false;
      switch (targetRoute) {
        case 'main':
        case 'progress': {
          const pane = document.querySelector<HTMLElement>(
            '.task-conversation-pane[data-pane="launcher"]',
          );
          return pane != null && pane.hidden === false;
        }
        case 'settings': {
          const tab = document.querySelector<HTMLElement>(
            '.task-workbench-tab[data-kind="settings"][data-active="true"]',
          );
          const settings = document.querySelector<HTMLElement>(
            '.task-workbench-surface settings-app[data-desktop-view="settings"]',
          );
          return (
            shell.dataset.workbenchOpen === 'true' &&
            tab != null &&
            settings != null
          );
        }
        case 'logs': {
          const tab = document.querySelector<HTMLElement>(
            '.task-workbench-tab[data-kind="logs"][data-active="true"]',
          );
          const logs = document.querySelector<HTMLElement>(
            '.task-workbench-surface [data-desktop-view="logs"]',
          );
          return (
            shell.dataset.workbenchOpen === 'true' &&
            tab != null &&
            logs != null
          );
        }
      }
    },
    route,
    { timeout: 5000 },
  );
}

async function selectSettingsTab(panelName: string): Promise<void> {
  await launched.page.waitForFunction(
    (panel) => {
      const settingsApp = document.querySelector(
        'settings-app[data-desktop-view="settings"]',
      );
      return (
        settingsApp?.shadowRoot?.querySelector(`wa-tab[panel="${panel}"]`) !=
        null
      );
    },
    panelName,
    { timeout: 10000 },
  );
  await launched.page.evaluate((panel) => {
    const settingsApp = document.querySelector(
      'settings-app[data-desktop-view="settings"]',
    );
    const tab = settingsApp?.shadowRoot?.querySelector<HTMLElement>(
      `wa-tab[panel="${panel}"]`,
    );
    if (!tab) {
      throw new Error(`Settings tab not found: ${panel}`);
    }
    tab.click();
  }, panelName);
  await launched.page.waitForFunction(
    (panel) => {
      const settingsApp = document.querySelector(
        'settings-app[data-desktop-view="settings"]',
      );
      const root = settingsApp?.shadowRoot;
      if (!root) return false;
      const activeTab = root.querySelector(`wa-tab[panel="${panel}"][active]`);
      const activePanel = root.querySelector(
        `wa-tab-panel[name="${panel}"][active]`,
      );
      return activeTab != null || activePanel != null;
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
  await setRoute('main');
  await launched.page.screenshot({
    path: join(SCREENSHOTS_DIR, 'launcher.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});

test('progress screenshot', async () => {
  // With no active stream, the permanent task canvas stays on <main-app>.
  // Capture it with the project/task sidebar — the default progress surface.
  await setRoute('progress');
  await launched.page.screenshot({
    path: join(SCREENSHOTS_DIR, 'progress.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});

test('settings screenshot', async () => {
  await setRoute('settings');
  // Open the Multi-Agent settings tab — the most visually rich area.
  await selectSettingsTab('multi-agent');
  await launched.page.screenshot({
    path: join(SCREENSHOTS_DIR, 'settings.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});

test('command palette opens and dismisses', async () => {
  await setRoute('main');
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
