import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

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
  // SETTINGS_TAB_ORDER index 4 = 'MULTI_AGENT'
  // (see src/shared/schemas/settingsViewMessages.ts).
  await launched.page.evaluate(() => {
    window.postMessage({ command: 'setTab', tabIndex: 4 }, '*');
  });
  await launched.page.waitForTimeout(500);
  await launched.page.screenshot({
    path: join(SCREENSHOTS_DIR, 'settings.png'),
    fullPage: false,
  });
  expect(launched.page.url()).toBeTruthy();
});
