import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  openWorkbench,
  showLauncher,
  type LaunchedApp,
} from './electronApp.js';

// Inlined rather than imported from src/shared: Playwright's ESM loader can't
// resolve a relative .js import of a TS file under src/shared (see
// packages/desktop/tests/e2e/README.md § Cross-package imports;
// settingsPersistence.spec.ts does the same). Source of truth:
// SETTINGS_VIEW_CMD.SET_TAB in src/shared/ipc.ts; SETTINGS_TAB_INDEX.TOOLS
// (index of 'TOOLS' in SETTINGS_TAB_ORDER) in
// src/shared/schemas/settingsViewMessages.ts.
const SET_TAB_COMMAND = 'setTab';
const SETTINGS_TAB_INDEX = {
  TOOLS: 4,
} as const;

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchTexraApp();
  await dismissOnboarding(launched.page);
});

test.afterAll(async () => {
  if (launched) await closeTexraApp(launched);
});

/**
 * Read the scroll metrics of the active Settings page.
 */
async function readToolsPanelMetrics(): Promise<{
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
} | null> {
  return launched.page.evaluate(() => {
    const settingsApp = document.querySelector(
      'settings-app[data-desktop-view="settings"]',
    );
    const root = settingsApp?.shadowRoot;
    const panel = root?.querySelector<HTMLElement>('.settings-panel');
    if (!panel) return null;
    return {
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
      scrollTop: panel.scrollTop,
    };
  });
}

test('main view no longer renders inner Launcher/Progress toolbar', async ({}, testInfo) => {
  await showLauncher(launched);
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

test('command palette keeps each icon and label in one compact row', async ({}, testInfo) => {
  await showLauncher(launched);
  const closeWorkbench = launched.page.locator('.task-workbench-close');
  if (await closeWorkbench.isVisible()) {
    await closeWorkbench.click();
  }
  await launched.page
    .locator('.task-header-button[aria-label="Show Commands"]')
    .click();
  await launched.page.waitForSelector(
    '.desktop-command-palette-item[aria-selected="true"]',
  );
  await launched.page.waitForTimeout(180);

  const metrics = await launched.page.evaluate(() => {
    const items = [
      ...document.querySelectorAll<HTMLElement>(
        '.desktop-command-palette-item',
      ),
    ];
    const rows = items.map((item) => {
      const main = item.querySelector<HTMLElement>(
        '.desktop-command-palette-main',
      );
      const icon = item.querySelector<HTMLElement>(
        '.desktop-command-palette-item-icon',
      );
      const copy = item.querySelector<HTMLElement>(
        '.desktop-command-palette-copy',
      );
      return {
        item: item.getBoundingClientRect(),
        main: main?.getBoundingClientRect(),
        icon: icon?.getBoundingClientRect(),
        copy: copy?.getBoundingClientRect(),
      };
    });
    const iconNames = new Set(
      items
        .map((item) => item.querySelector('wa-icon')?.getAttribute('name'))
        .filter(Boolean),
    );
    return { rows, uniqueIconCount: iconNames.size };
  });

  await launched.page.screenshot({
    path: testInfo.outputPath('verify-fixes', 'command-palette.png'),
    fullPage: false,
  });

  for (const row of metrics.rows) {
    expect(row.main).toBeTruthy();
    expect(row.icon).toBeTruthy();
    expect(row.copy).toBeTruthy();
    expect(row.item.height).toBeLessThanOrEqual(52);
    expect(row.icon!.right).toBeLessThanOrEqual(row.copy!.left);
    expect(row.main!.top).toBeGreaterThanOrEqual(row.item.top);
    expect(row.main!.bottom).toBeLessThanOrEqual(row.item.bottom);
  }
  expect(metrics.uniqueIconCount).toBeGreaterThan(8);
  await launched.page.keyboard.press('Escape');
});

test('settings workbench scrolls (Tools tab top + bottom)', async ({}, testInfo) => {
  await openWorkbench(launched, 'settings');
  await launched.page.evaluate(
    ({ command, tabIndex }) => {
      window.postMessage({ command, tabIndex }, '*');
    },
    {
      command: SET_TAB_COMMAND,
      tabIndex: SETTINGS_TAB_INDEX.TOOLS,
    },
  );
  // Wait for the Tools page to be marked active AND its content to have
  // finished loading. ToolsTab renders a `.loading-state`
  // placeholder while `loaded` is false and swaps in `<tool-card>` elements
  // once the tool dashboard data has arrived (see ToolsTab.ts render()); the
  // panel's scrollHeight only reflects real content after that swap, so
  // gating on the navigation state alone races content population and can catch
  // the panel mid-load (scrollHeight === clientHeight).
  await launched.page.waitForFunction(
    () => {
      const settingsApp = document.querySelector(
        'settings-app[data-desktop-view="settings"]',
      );
      const root = settingsApp?.shadowRoot;
      if (!root) return false;
      const activePage = root.querySelector(
        '.settings-page-button[data-panel="tools"][data-active="true"]',
      );
      if (!activePage) return false;
      const toolsTab = root.querySelector('tools-tab');
      const toolsRoot = toolsTab?.shadowRoot;
      if (!toolsRoot) return false;
      return toolsRoot.querySelector('tool-card') != null;
    },
    undefined,
    { timeout: 10_000 },
  );

  // The active Settings page owns scrolling for every hierarchical page.
  const probeBefore = await readToolsPanelMetrics();
  console.log('tools panel before scroll:', probeBefore);

  await launched.page.screenshot({
    path: testInfo.outputPath('verify-fixes', 'settings-tools-top.png'),
    fullPage: false,
  });

  // Scroll the panel to the bottom and re-screenshot.
  await launched.page.evaluate(() => {
    const settingsApp = document.querySelector(
      'settings-app[data-desktop-view="settings"]',
    );
    const root = settingsApp?.shadowRoot;
    const panel = root?.querySelector<HTMLElement>('.settings-panel');
    if (panel) panel.scrollTop = panel.scrollHeight;
  });
  await launched.page.waitForTimeout(150);

  const probeAfter = await readToolsPanelMetrics();
  console.log('tools panel after scroll:', probeAfter);

  await launched.page.screenshot({
    path: testInfo.outputPath('verify-fixes', 'settings-tools-bottom.png'),
    fullPage: false,
  });

  expect(probeBefore).not.toBeNull();
  expect(probeAfter).not.toBeNull();
  // Real verification: the panel must be scrollable (content > viewport),
  // and scrollTop must move when we set it.
  expect(probeBefore!.scrollHeight).toBeGreaterThan(probeBefore!.clientHeight);
  expect(probeAfter!.scrollTop).toBeGreaterThan(0);
});
