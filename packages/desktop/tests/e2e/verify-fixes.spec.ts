import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

// Inlined rather than imported from src/shared: Playwright's ESM loader can't
// resolve a relative .js import of a TS file under src/shared (see
// packages/desktop/tests/e2e/README.md § Cross-package imports;
// settingsPersistence.spec.ts does the same). Source of truth:
// SETTINGS_VIEW_CMD.SET_TAB in src/shared/ipc.ts; SETTINGS_TAB_INDEX.TOOLS
// (index of 'TOOLS' in SETTINGS_TAB_ORDER) in
// src/shared/schemas/settingsView/data.ts.
const SET_TAB_COMMAND = 'setTab';
const SETTINGS_TAB_INDEX = {
  TOOLS: 5,
} as const;

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchTexraApp();
  await dismissOnboarding(launched.page);
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

/**
 * Read the scroll metrics of the Tools settings panel (the scrollable element
 * under the flex-body fix). Returns null when the panel has not mounted.
 */
async function readToolsPanelMetrics(): Promise<{
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
} | null> {
  return launched.page.evaluate(() => {
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
}

test('main view no longer renders inner Launcher/Progress toolbar', async ({}, testInfo) => {
  await setRoute('main');
  await launched.page.screenshot({
    path: testInfo.outputPath('verify-fixes', 'main-view.png'),
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

test('settings overlay scrolls (Tools tab top + bottom)', async ({}, testInfo) => {
  await setRoute('settings');
  await launched.page.evaluate(
    ({ command, tabIndex }) => {
      window.postMessage({ command, tabIndex }, '*');
    },
    {
      command: SET_TAB_COMMAND,
      tabIndex: SETTINGS_TAB_INDEX.TOOLS,
    },
  );
  // The panel becomes active before its asynchronous dashboard content renders.
  await launched.page.waitForFunction(
    () => {
      const dialog = document.querySelector(
        'wa-dialog.desktop-settings-overlay',
      );
      const settingsApp = dialog?.querySelector('settings-app');
      const root = settingsApp?.shadowRoot;
      if (!root) return false;
      const panel = root.querySelector<HTMLElement>(
        'wa-tab-panel[name="tools"][active]',
      );
      const toolsTab = panel?.querySelector<HTMLElement & { loaded: boolean }>(
        'tools-tab',
      );
      if (!panel || toolsTab?.loaded !== true || !toolsTab.shadowRoot) {
        return false;
      }
      const hasRenderedTools =
        toolsTab.shadowRoot.querySelectorAll('tool-card').length > 0;
      return hasRenderedTools && panel.scrollHeight > panel.clientHeight;
    },
    undefined,
    { timeout: 10_000 },
  );

  // Find the wa-tab-panel for tools — that's the scrollable element under
  // the new flex-body fix.
  const probeBefore = await readToolsPanelMetrics();
  console.log('tools panel before scroll:', probeBefore);

  await launched.page.screenshot({
    path: testInfo.outputPath('verify-fixes', 'settings-tools-top.png'),
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
  await launched.page.waitForFunction(
    () => {
      const dialog = document.querySelector(
        'wa-dialog.desktop-settings-overlay',
      );
      const settingsApp = dialog?.querySelector('settings-app');
      const root = settingsApp?.shadowRoot;
      const panel = root?.querySelector<HTMLElement>(
        'wa-tab-panel[name="tools"]',
      );
      return (
        panel != null &&
        panel.scrollTop > 0 &&
        panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1
      );
    },
    undefined,
    { timeout: 5000 },
  );

  const probeAfter = await readToolsPanelMetrics();
  console.log('tools panel after scroll:', probeAfter);

  await launched.page.screenshot({
    path: testInfo.outputPath('verify-fixes', 'settings-tools-bottom.png'),
    fullPage: false,
  });

  expect(probeBefore).not.toBeNull();
  expect(probeAfter).not.toBeNull();
  // Real verification: the panel must be scrollable (content > viewport),
  // start at the top, and reach the bottom when scrolled.
  expect(probeBefore!.scrollHeight).toBeGreaterThan(probeBefore!.clientHeight);
  expect(probeBefore!.scrollTop).toBe(0);
  expect(probeAfter!.scrollTop).toBeGreaterThan(0);
  expect(
    probeAfter!.scrollTop + probeAfter!.clientHeight,
  ).toBeGreaterThanOrEqual(probeAfter!.scrollHeight - 1);
});
