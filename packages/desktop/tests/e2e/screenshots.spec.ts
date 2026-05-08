import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

// Mirror of `SETTINGS_TAB.MULTI_AGENT` from
// `src/shared/schemas/settingsViewMessages.ts`. Inlined because the cross-
// package TS import via Playwright's ESM loader trips over the `.js` suffix
// resolving to a CommonJS-shaped module ("Named export 'SETTINGS_TAB' not
// found") and fails the entire test discovery. The settings tab order is
// stable; if it changes, both the schema and this constant must update.
const MULTI_AGENT_TAB_INDEX = 4;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(HERE, '__screenshots__');

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchTexraApp();
  await launched.page.waitForFunction(
    () => {
      const btn = Array.from(document.querySelectorAll('wa-button')).find(
        (b) => b.textContent?.trim() === 'Got it',
      );
      return btn instanceof HTMLElement;
    },
    undefined,
    { timeout: 10000 },
  );
  const dismissed = await launched.page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('wa-button')).find(
      (b) => b.textContent?.trim() === 'Got it',
    );
    if (btn instanceof HTMLElement) {
      btn.click();
      return true;
    }
    return false;
  });
  if (dismissed) {
    await launched.page
      .locator('wa-dialog.desktop-onboarding')
      .waitFor({ state: 'hidden', timeout: 5000 });
  }
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
  const multiAgentTabIndex = MULTI_AGENT_TAB_INDEX;
  await launched.page.evaluate((tabIndex) => {
    window.postMessage({ command: 'setTab', tabIndex }, '*');
  }, multiAgentTabIndex);
  await launched.page.waitForFunction(
    () => {
      const dialog = document.querySelector(
        'wa-dialog.desktop-settings-overlay',
      );
      const settingsApp = dialog?.querySelector('settings-app');
      const root = settingsApp?.shadowRoot;
      if (!root) return false;
      const activeTab = root.querySelector(
        'wa-tab[panel="multi-agent"][active]',
      );
      const activePanel = root.querySelector(
        'wa-tab-panel[name="multi-agent"][active]',
      );
      return activeTab != null || activePanel != null;
    },
    undefined,
    { timeout: 10000 },
  );
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
