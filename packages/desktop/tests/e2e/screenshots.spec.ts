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
  await dismissOnboarding(launched.page);
});

test.afterAll(async () => {
  if (launched) {
    await closeTexraApp(launched);
  }
});

/**
 * Send a `desktop:setRoute` IPC message to drive the new shell:
 *   - 'main' / 'progress' map to the center pane
 *   - 'settings' opens the wa-dialog overlay
 *   - 'logs' opens the wa-drawer drawer
 *
 * After PRD § 7.D the four-route shell is gone, so this helper waits on the
 * appropriate surface for the requested target rather than the old
 * `.desktop-route[data-route]` container.
 */
async function setRoute(
  route: 'main' | 'progress' | 'settings' | 'logs',
): Promise<void> {
  await launched.page.evaluate((next) => {
    window.postMessage({ command: 'desktop:setRoute', route: next }, '*');
  }, route);
  await launched.page.waitForFunction(
    (targetRoute) => {
      switch (targetRoute) {
        case 'main':
        case 'progress': {
          const pane = document.querySelector<HTMLElement>(
            '.desktop-pane[data-pane="launcher"]',
          );
          return pane != null && pane.hidden === false;
        }
        case 'settings': {
          const dialog = document.querySelector<HTMLElement>(
            'wa-dialog.desktop-settings-overlay',
          );
          return dialog != null && dialog.hasAttribute('open');
        }
        case 'logs': {
          const drawer = document.querySelector<HTMLElement>(
            'wa-drawer.desktop-logs-drawer',
          );
          return drawer != null && drawer.hasAttribute('open');
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
      const dialog = document.querySelector(
        'wa-dialog.desktop-settings-overlay',
      );
      const settingsApp = dialog?.querySelector('settings-app');
      return (
        settingsApp?.shadowRoot?.querySelector(`wa-tab[panel="${panel}"]`) !=
        null
      );
    },
    panelName,
    { timeout: 10000 },
  );
  await launched.page.evaluate((panel) => {
    const dialog = document.querySelector('wa-dialog.desktop-settings-overlay');
    const settingsApp = dialog?.querySelector('settings-app');
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
      const dialog = document.querySelector(
        'wa-dialog.desktop-settings-overlay',
      );
      const settingsApp = dialog?.querySelector('settings-app');
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

test('launcher screenshot', async () => {
  await setRoute('main');
  await launched.page.screenshot({
    path: join(SCREENSHOTS_DIR, 'launcher.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});

test('progress screenshot', async () => {
  // With no active stream, the center pane stays on <main-app>. The rail on
  // the left is the visible "progress" surface (sessions list). Capture the
  // rail + launcher together — that's the new default progress experience.
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
  // Close the settings overlay if a previous test left it open.
  await launched.page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      'wa-dialog.desktop-settings-overlay',
    );
    if (dialog && dialog.hasAttribute('open')) {
      dialog.removeAttribute('open');
    }
  });
  const opened = await launched.page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>('.desktop-command-button');
    if (!btn) return false;
    btn.click();
    return true;
  });
  expect(opened).toBe(true);
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
