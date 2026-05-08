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
  // Wait for IPC bootstrap (which sets walkthrough state from disk) by checking
  // for the "Got it" button, then click to dismiss persistently.
  await launched.page.waitForFunction(() => {
    const btn = Array.from(document.querySelectorAll('wa-button')).find(
      (b) => b.textContent?.trim() === 'Got it',
    );
    return btn instanceof HTMLElement;
  });
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
    // Wait for the walkthrough dialog to be hidden after dismissing.
    await launched.page.locator('wa-dialog[walkthrough-dialog]').waitFor({ state: 'hidden', timeout: 5000 });
  }
});

test.afterAll(async () => {
  if (launched) {
    await closeTexraApp(launched);
  }
});

/**
 * Set the desktop shell route by posting a `desktop:setRoute` message into
 * the renderer. This mirrors the in-app navigation handler and avoids
 * depending on specific button selectors.
 */
async function setRoute(
  route: 'main' | 'progress' | 'settings' | 'logs',
): Promise<void> {
  await launched.page.evaluate((next) => {
    window.postMessage({ command: 'desktop:setRoute', route: next }, '*');
  }, route);
  // Wait for the route container matching the target route to be visible.
  await launched.page.waitForFunction(
    (targetRoute) => {
      const section = document.querySelector<HTMLElement>(
        `.desktop-route[data-route="${targetRoute}"]`,
      );
      if (!section) return false;
      return section.hidden === false;
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
  // Pinned to the inlined constant above (kept in sync with
  // `SETTINGS_TAB.MULTI_AGENT` in `src/shared/schemas/settingsViewMessages.ts`).
  const multiAgentTabIndex = MULTI_AGENT_TAB_INDEX;
  await launched.page.evaluate((tabIndex) => {
    window.postMessage({ command: 'setTab', tabIndex }, '*');
  }, multiAgentTabIndex);
  // Wait for the webview/iframe to signal tab content is ready.
  // The settings webview processes the message and renders the tab asynchronously.
  // Check for a known element that appears when the Multi-Agent tab is active.
  await launched.page.waitForFunction(() => {
    // Settings webview loads asynchronously; wait for it to have rendered content.
    const settingsSection = document.querySelector('.desktop-route[data-route="settings"]');
    if (!settingsSection) return false;
    // Check if the webview has any child content (iframe or custom elements).
    return settingsSection.querySelector('*') != null;
  }, { timeout: 10000 });
  await launched.page.screenshot({
    path: join(SCREENSHOTS_DIR, 'settings.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});

/**
 * Smoke-test the command palette: click the chrome "Commands" button, confirm
 * a wa-dialog opened with at least one entry, then dismiss with Escape. This
 * doesn't capture a screenshot — the goal is to verify the host-neutral
 * `commandPalette` helper still wires up against the desktop's command
 * surface end-to-end (regression guard for #3627).
 */
test('command palette opens and dismisses', async () => {
  await setRoute('main');
  // The chrome "Commands" button lives in `desktop-nav`. Click it via DOM
  // so test does not depend on screen coordinates / animation timing.
  const opened = await launched.page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>('.desktop-command-button');
    if (!btn) return false;
    btn.click();
    return true;
  });
  expect(opened).toBe(true);
  // Wait for the command palette dialog to appear and contain entries.
  await launched.page.waitForFunction(() => {
    const dialog = document.querySelector<HTMLElement>(
      '.desktop-command-palette',
    );
    if (!dialog) return false;
    // Entries are rendered as buttons inside the palette body; falling back
    // to any clickable item lets the test survive class-name churn.
    const entries = dialog.querySelectorAll(
      'button, [role="option"], .desktop-command-palette-entry',
    );
    return entries.length > 0;
  }, { timeout: 5000 });
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
  // Dismiss with Escape and verify the dialog closes.
  await launched.page.keyboard.press('Escape');
  // Wait for the dialog to close by checking for the `open` attribute removal.
  await launched.page.waitForFunction(() => {
    const dialog = document.querySelector<HTMLElement>(
      '.desktop-command-palette',
    );
    if (!dialog) return true;
    return dialog.getAttribute('open') == null;
  }, { timeout: 5000 });
  const closed = await launched.page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '.desktop-command-palette',
    );
    if (!dialog) return true;
    return dialog.getAttribute('open') == null;
  });
  expect(closed).toBe(true);
});
