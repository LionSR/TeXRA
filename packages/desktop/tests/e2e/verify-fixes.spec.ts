import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'test-results', 'verify-fixes');

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
  await launched.page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('wa-button')).find(
      (b) => b.textContent?.trim() === 'Got it',
    );
    if (btn instanceof HTMLElement) btn.click();
  });
  await launched.page
    .locator('wa-dialog.desktop-onboarding')
    .waitFor({ state: 'hidden', timeout: 5000 });
});

test.afterAll(async () => {
  if (launched) await closeTexraApp(launched);
});

async function setRoute(route: 'main' | 'settings'): Promise<void> {
  await launched.page.evaluate((r) => {
    window.postMessage({ command: 'desktop:setRoute', route: r }, '*');
  }, route);
  await launched.page.waitForFunction(
    (r) => {
      if (r === 'main') {
        const pane = document.querySelector<HTMLElement>(
          '.desktop-pane[data-pane="launcher"]',
        );
        return pane != null && pane.hidden === false;
      }
      const dialog = document.querySelector<HTMLElement>(
        'wa-dialog.desktop-settings-overlay',
      );
      return dialog != null && dialog.hasAttribute('open');
    },
    route,
    { timeout: 5000 },
  );
}

test('main view no longer renders inner Launcher/Progress toolbar', async () => {
  await setRoute('main');
  await launched.page.screenshot({
    path: join(OUT, 'main-view.png'),
    fullPage: false,
  });
  // Probe the <main-app> shadow root for the view-header div + the
  // latexdiffs-section. Both should be absent in the desktop host.
  const probe = await launched.page.evaluate(() => {
    const mainApp = document.querySelector('main-app');
    const root = mainApp?.shadowRoot;
    if (!root) return { hasRoot: false };
    return {
      hasRoot: true,
      viewHeader: root.querySelector('.view-header') != null,
      viewTabs: root.querySelector('.view-tabs') != null,
      latexdiffs: root.querySelector('latexdiffs-section') != null,
    };
  });
  console.log('main-app probe:', probe);
  expect(probe.hasRoot).toBe(true);
  expect(probe.viewHeader).toBe(false);
  expect(probe.viewTabs).toBe(false);
  expect(probe.latexdiffs).toBe(false);
});

test('settings overlay scrolls (Tools tab top + bottom)', async () => {
  await setRoute('settings');
  // Open Tools tab (index 5: Memory(0) History(1) Models(2) Agents(3)
  // Multi-Agent(4) Tools(5)).
  await launched.page.evaluate(() => {
    window.postMessage({ command: 'setTab', tabIndex: 5 }, '*');
  });
  await launched.page.waitForFunction(
    () => {
      const dialog = document.querySelector(
        'wa-dialog.desktop-settings-overlay',
      );
      const settingsApp = dialog?.querySelector('settings-app');
      const root = settingsApp?.shadowRoot;
      if (!root) return false;
      return root.querySelector('wa-tab-panel[name="tools"][active]') != null;
    },
    undefined,
    { timeout: 10_000 },
  );

  // Find the wa-tab-panel for tools — that's the scrollable element under
  // the new flex-body fix.
  const probeBefore = await launched.page.evaluate(() => {
    const dialog = document.querySelector('wa-dialog.desktop-settings-overlay');
    const settingsApp = dialog?.querySelector('settings-app');
    const root = settingsApp?.shadowRoot;
    const panel = root?.querySelector<HTMLElement>(
      'wa-tab-panel[name="tools"]',
    );
    if (!panel) return null;
    return {
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
      scrollTop: panel.scrollTop,
    };
  });
  console.log('tools panel before scroll:', probeBefore);

  await launched.page.screenshot({
    path: join(OUT, 'settings-tools-top.png'),
    fullPage: false,
  });

  // Scroll the panel to the bottom and re-screenshot.
  await launched.page.evaluate(() => {
    const dialog = document.querySelector('wa-dialog.desktop-settings-overlay');
    const settingsApp = dialog?.querySelector('settings-app');
    const root = settingsApp?.shadowRoot;
    const panel = root?.querySelector<HTMLElement>(
      'wa-tab-panel[name="tools"]',
    );
    if (panel) panel.scrollTop = panel.scrollHeight;
  });
  await launched.page.waitForTimeout(150);

  const probeAfter = await launched.page.evaluate(() => {
    const dialog = document.querySelector('wa-dialog.desktop-settings-overlay');
    const settingsApp = dialog?.querySelector('settings-app');
    const root = settingsApp?.shadowRoot;
    const panel = root?.querySelector<HTMLElement>(
      'wa-tab-panel[name="tools"]',
    );
    if (!panel) return null;
    return {
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
      scrollTop: panel.scrollTop,
    };
  });
  console.log('tools panel after scroll:', probeAfter);

  await launched.page.screenshot({
    path: join(OUT, 'settings-tools-bottom.png'),
    fullPage: false,
  });

  expect(probeBefore).not.toBeNull();
  expect(probeAfter).not.toBeNull();
  // Real verification: the panel must be scrollable (content > viewport),
  // and scrollTop must move when we set it.
  expect(probeBefore!.scrollHeight).toBeGreaterThan(probeBefore!.clientHeight);
  expect(probeAfter!.scrollTop).toBeGreaterThan(0);
});
