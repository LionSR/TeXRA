import { writeFileSync } from 'node:fs';
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

test.beforeAll(async () => {
  launched = await launchTexraApp();
  await dismissOnboarding(launched.page);
  // A known file so the editor tree has something deterministic to open.
  writeFileSync(
    join(launched.workspacePath, 'sample.tex'),
    '\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}\n',
    'utf8',
  );
});

test.afterAll(async () => {
  if (launched) await closeTexraApp(launched);
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
  await expect(page.locator('.task-workbench')).toHaveCount(0);
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
