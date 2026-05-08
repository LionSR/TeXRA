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
  // Wait for IPC bootstrap (which sets walkthrough state from disk),
  // then click the walkthrough's "Got it" button to dismiss persistently.
  await launched.page.waitForTimeout(500);
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
    await launched.page.waitForTimeout(300);
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
  // Allow the shell to rerender + the target view to mount.
  await launched.page.waitForTimeout(500);
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
  await launched.page.waitForTimeout(500);
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
  await launched.page.waitForTimeout(300);
  // Wait for the wa-dialog to be present and have at least one palette entry.
  const entryCount = await launched.page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '.desktop-command-palette',
    );
    if (!dialog) return -1;
    // Entries are rendered as buttons inside the palette body; falling back
    // to any clickable item lets the test survive class-name churn.
    const entries = dialog.querySelectorAll(
      'button, [role="option"], .desktop-command-palette-entry',
    );
    return entries.length;
  });
  expect(entryCount).toBeGreaterThan(0);
  // Dismiss with Escape and verify the dialog closes.
  await launched.page.keyboard.press('Escape');
  await launched.page.waitForTimeout(200);
  const closed = await launched.page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '.desktop-command-palette',
    );
    if (!dialog) return true;
    // wa-dialog uses an `open` attribute; absence means closed.
    return dialog.getAttribute('open') == null;
  });
  expect(closed).toBe(true);
});
