import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

// End-to-end coverage for the task-centric shell. The conversation is permanent
// while Settings, Logs, editor, terminal, and browser surfaces share the right
// workbench. The task-shell reducer is unit-tested separately; this suite checks
// the wiring that unit tests cannot reach — that workbench tabs mount their
// panes, Monaco loads a real file from disk, and a pty produces output.

let launched: LaunchedApp;
let workspacePath: string;

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'texra-shell-e2e-'));
  writeFileSync(
    join(workspacePath, 'sample.tex'),
    '\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}\n',
    'utf8',
  );
  writeFileSync(
    join(workspacePath, 'sample.ts'),
    'export const projectTreeLoaded = true;\n',
    'utf8',
  );
  launched = await launchTexraApp({ workspacePath });
  await dismissOnboarding(launched.page);
});

test.afterAll(async () => {
  if (launched) await closeTexraApp(launched);
  if (workspacePath) rmSync(workspacePath, { recursive: true, force: true });
});

/** Opens one of the workbench actions permanently exposed in the sidebar. */
async function openSidebarWorkbench(label: string): Promise<void> {
  await launched.page
    .locator('.task-sidebar-footer .task-sidebar-action')
    .filter({ hasText: label })
    .click();
}

/** Opens the generic editor workbench from the task environment menu. */
async function openEditorWorkbench(): Promise<void> {
  await launched.page.locator('.task-environment-button').click();
  await launched.page
    .locator('.task-environment-action')
    .filter({ hasText: 'Editor' })
    .click();
}

function activeWorkbenchTab(kind: string): string {
  return `.task-workbench-tab[data-kind="${kind}"][data-active="true"]`;
}

test('opens with a permanent task conversation and no workbench', async () => {
  const { page } = launched;

  await expect(page.locator('.task-shell')).toBeVisible();
  await expect(page.locator('.task-shell')).toHaveAttribute(
    'data-workbench-open',
    'false',
  );
  await expect(page.locator('.task-conversation')).toBeVisible();
  await expect(
    page.locator('.task-conversation-pane[data-pane="launcher"]:not([hidden])'),
  ).toBeVisible();
  await expect(
    page.locator('main-app[data-desktop-view="main"]'),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector('main-app')
            ?.shadowRoot?.querySelector('.launcher-loading') != null,
      ),
    )
    .toBe(false);
  await expect(page.locator('.task-workbench')).toHaveCount(0);
});

test('loads the project tree before an editor panel is opened', async () => {
  const { page } = launched;

  await expect(
    page.locator('.desktop-editor-tree-row:has-text("sample.tex")'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('.desktop-editor-tree-row:has-text("sample.ts")'),
  ).toBeVisible();
  await expect(
    page.locator('.desktop-editor-tree-empty:has-text("No files found")'),
  ).toHaveCount(0);
});

test('resizes the window canvas and project sidebar', async () => {
  const { app, page } = launched;

  const contentBounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().at(0);
    if (!window) throw new Error('TeXRA window was not found.');
    window.setContentSize(1500, 900);
    return window.getContentBounds();
  });

  await expect
    .poll(() => page.evaluate(() => window.innerWidth))
    .toBe(contentBounds.width);
  await expect
    .poll(() =>
      page
        .locator('.task-shell')
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(contentBounds.width);

  const sidebar = page.locator('.task-sidebar-slot');
  const divider = page.locator('.task-shell [part="divider"]').first();
  const initialSidebarWidth = (await sidebar.boundingBox())?.width;
  expect(initialSidebarWidth).toBeDefined();
  if (initialSidebarWidth == null) return;

  // Web Awesome owns pointer and keyboard resizing. Use its documented
  // keyboard path here because Playwright's synthetic Electron mouse emits
  // `mousemove` without the `pointermove` that Web Awesome's drag helper
  // consumes; a real pointing device emits both.
  await divider.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeGreaterThan(initialSidebarWidth + 40);
});

test('aligns titlebar content and keeps the collapsed toggle clear of macOS controls', async () => {
  const { app, page } = launched;
  const brand = await page.locator('.task-sidebar-brand').boundingBox();
  const taskHeader = await page.locator('.task-header').boundingBox();
  expect(brand).not.toBeNull();
  expect(taskHeader).not.toBeNull();
  expect(brand?.height).toBe(taskHeader?.height);
  expect(brand?.y).toBe(taskHeader?.y);

  const toggle = page.locator('.task-header-button[aria-label$="sidebar"]');
  await toggle.click();
  await expect(page.locator('.task-shell-collapsed')).toBeVisible();

  const platform = await app.evaluate(() => process.platform);
  const toggleBounds = await toggle.boundingBox();
  expect(toggleBounds).not.toBeNull();
  if (platform === 'darwin') {
    expect(toggleBounds?.x).toBeGreaterThanOrEqual(76);
  }

  await toggle.click();
  await expect(page.locator('.task-sidebar')).toBeVisible();
});

test('uses normal macOS workspace and stacking behavior', async () => {
  const flags = await launched.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().at(0);
    if (!window) throw new Error('TeXRA window was not found.');
    return {
      alwaysOnTop: window.isAlwaysOnTop(),
      visibleOnAllWorkspaces: window.isVisibleOnAllWorkspaces(),
    };
  });

  expect(flags).toEqual({
    alwaysOnTop: false,
    visibleOnAllWorkspaces: false,
  });
});

test('keeps the composer grouped and centered at compact widths', async () => {
  const { app, page } = launched;

  const contentBounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().at(0);
    if (!window) throw new Error('TeXRA window was not found.');
    window.setContentSize(1000, 760);
    return window.getContentBounds();
  });
  await expect
    .poll(() => page.evaluate(() => window.innerWidth))
    .toBe(contentBounds.width);

  const layout = await page.evaluate(() => {
    const mainApp = document.querySelector('main-app');
    const panel =
      mainApp?.shadowRoot?.querySelector<HTMLElement>('instruction-panel');
    const root = panel?.shadowRoot;
    const box = root?.querySelector<HTMLElement>('.instruction-box');
    const mode = root?.querySelector<HTMLElement>('.desktop-mode-controls');
    const agent = root?.querySelector<HTMLElement>('.agent-select-group');
    const model = root?.querySelector<HTMLElement>('.model-select-group');
    const execute = root?.querySelector<HTMLElement>('#executeButton');
    const executeBase =
      execute?.shadowRoot?.querySelector<HTMLElement>('[part~="base"]');
    const arrow = execute?.querySelector<HTMLElement>('wa-icon');
    if (!box || !mode || !agent || !model || !executeBase || !arrow) {
      throw new Error('Desktop composer controls were not mounted.');
    }

    const modeRect = mode.getBoundingClientRect();
    const agentRect = agent.getBoundingClientRect();
    const modelRect = model.getBoundingClientRect();
    const buttonRect = executeBase.getBoundingClientRect();
    const arrowRect = arrow.getBoundingClientRect();
    return {
      overflow: box.scrollWidth - box.clientWidth,
      modeBottom: modeRect.bottom,
      pickerTop: Math.min(agentRect.top, modelRect.top),
      pickerCenter: (agentRect.top + agentRect.bottom) / 2,
      modelCenter: (modelRect.top + modelRect.bottom) / 2,
      modelBottom: modelRect.bottom,
      buttonBottom: buttonRect.bottom,
      horizontalArrowOffset:
        (arrowRect.left + arrowRect.right) / 2 -
        (buttonRect.left + buttonRect.right) / 2,
      verticalArrowOffset:
        (arrowRect.top + arrowRect.bottom) / 2 -
        (buttonRect.top + buttonRect.bottom) / 2,
    };
  });

  expect(layout.overflow).toBe(0);
  expect(layout.modeBottom).toBeLessThanOrEqual(layout.pickerTop);
  expect(Math.abs(layout.pickerCenter - layout.modelCenter)).toBeLessThan(1);
  expect(Math.abs(layout.buttonBottom - layout.modelBottom)).toBeLessThan(1);
  expect(Math.abs(layout.horizontalArrowOffset)).toBeLessThan(1);
  expect(Math.abs(layout.verticalArrowOffset)).toBeLessThan(1);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().at(0)?.setContentSize(1500, 900);
  });
});

test('uses one rectangular hover surface for workbench tabs', async () => {
  const { page } = launched;

  await openSidebarWorkbench('Browser');
  const browserTab = page.locator(activeWorkbenchTab('browser'));
  await expect(browserTab).toBeVisible();
  await browserTab.hover();

  const colors = await browserTab.evaluate((tab) => {
    const button = tab.querySelector<HTMLElement>(
      '.task-workbench-tab-activate',
    );
    const base =
      button?.shadowRoot?.querySelector<HTMLElement>('[part~="base"]');
    if (!base) throw new Error('Workbench tab button base was not found.');
    return {
      button: getComputedStyle(base).backgroundColor,
      tab: getComputedStyle(tab).backgroundColor,
    };
  });

  expect(colors.button).toBe('rgba(0, 0, 0, 0)');
  expect(colors.tab).not.toBe('rgba(0, 0, 0, 0)');
});

test('opens settings beside the permanent conversation', async () => {
  const { page } = launched;

  await openSidebarWorkbench('Settings');

  await expect(page.locator(activeWorkbenchTab('settings'))).toBeVisible();
  await expect(page.locator('.task-workbench')).toBeVisible();
  await expect(
    page.locator(
      '.task-workbench-surface settings-app[data-desktop-view="settings"]',
    ),
  ).toBeVisible();
  await expect(page.locator('.task-conversation')).toBeVisible();

  // Hiding the workbench must leave the task canvas mounted and visible.
  await page.locator('.task-workbench-close').click();
  await expect(page.locator('.task-shell')).toHaveAttribute(
    'data-workbench-open',
    'false',
  );
  await expect(page.locator('.task-workbench')).toHaveCount(0);
  await expect(page.locator('.task-conversation')).toBeVisible();
});

test('loads a workspace file into the Monaco editor workbench', async () => {
  const { page } = launched;

  await openEditorWorkbench();
  await expect(page.locator(activeWorkbenchTab('editor'))).toBeVisible();

  // The tree is populated from the same listing rules the agent file picker
  // uses, so the file written in beforeAll should appear.
  const row = page.locator('.desktop-editor-tree-row:has-text("sample.tex")');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();

  // Monaco renders its content into .view-lines; waiting on the text proves the
  // editor loaded AND that file I/O crossed the IPC boundary successfully.
  await expect(
    page.locator('.desktop-editor-surface .view-lines'),
  ).toContainText('documentclass', { timeout: 20_000 });
});

test('runs an interactive shell in a terminal workbench tab', async () => {
  const { page } = launched;

  await openSidebarWorkbench('Terminal');
  await expect(page.locator(activeWorkbenchTab('terminal'))).toBeVisible();

  // xterm renders rows into .xterm-rows. A prompt appearing at all proves the
  // pty spawned, node-pty loaded under Electron's ABI, and output streamed back
  // through IPC.
  const rows = page.locator('.desktop-terminal-surface .xterm-rows');
  await expect(rows).toBeVisible({ timeout: 20_000 });
  await expect(rows).not.toBeEmpty({ timeout: 20_000 });

  // Echo a unique token to confirm keystrokes reach the shell.
  await page.locator('.desktop-terminal-surface .xterm').click();
  await page.keyboard.type('echo texra-pty-ok');
  await page.keyboard.press('Enter');
  await expect(rows).toContainText('texra-pty-ok', { timeout: 20_000 });
});

test('closes a tab and falls back to its left neighbor', async () => {
  const { page } = launched;

  // Establish this test's own left neighbor and active tab. Playwright restarts
  // the worker after a failure, so depending on tabs opened by earlier tests
  // would turn one surface failure into a misleading cascade.
  await openSidebarWorkbench('Settings');
  await openSidebarWorkbench('Terminal');

  const tabs = page.locator('.task-workbench-tab');
  const before = await tabs.count();
  const terminalTab = page.locator(activeWorkbenchTab('terminal'));
  const fallbackLabel = await tabs
    .nth(before - 2)
    .locator('.task-workbench-tab-label')
    .innerText();
  await terminalTab.hover();
  await terminalTab.locator('.task-workbench-tab-close').click();

  await expect(tabs).toHaveCount(before - 1);
  await expect(
    page.locator(
      '.task-workbench-tab[data-active="true"] .task-workbench-tab-label',
    ),
  ).toHaveText(fallbackLabel);
  await expect(page.locator('.task-workbench-pane')).toBeVisible();
  await expect(page.locator('.task-conversation')).toBeVisible();
});

test('routes legacy desktop:setRoute IPC to the owning tab', async () => {
  const { page } = launched;

  // Menu items and the command palette still speak the four-route vocabulary;
  // each route must resolve to the tab that now owns that surface.
  await page.evaluate(() => {
    window.postMessage({ command: 'desktop:setRoute', route: 'logs' }, '*');
  });
  await expect(page.locator(activeWorkbenchTab('logs'))).toBeVisible();
  await expect(page.locator('.desktop-log-viewer')).toBeVisible();
  await expect(page.locator('.task-conversation')).toBeVisible();

  await page.evaluate(() => {
    window.postMessage({ command: 'desktop:setRoute', route: 'main' }, '*');
  });
  await expect(
    page.locator('.task-conversation-pane[data-pane="launcher"]:not([hidden])'),
  ).toBeVisible();
  // Returning to the launcher does not discard the inspected workbench.
  await expect(page.locator(activeWorkbenchTab('logs'))).toBeVisible();
});
