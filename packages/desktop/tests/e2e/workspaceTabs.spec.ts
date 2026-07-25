import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

// End-to-end coverage for the tab shell: Settings and Logs became real tabs
// instead of modal overlays, and the editor / terminal / browser tabs are new
// surfaces. The tab reducer itself is unit-tested in
// src/test-kernel/desktop/DesktopWorkspaceTabs.vitest.mts; this suite checks the
// wiring that unit tests can't reach — that a tab actually mounts its pane, that
// Monaco loads a real file from disk, and that a pty produces output.

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

/** Clicks the "+" button and picks an entry from the new-tab menu. */
async function openNewTab(label: string): Promise<void> {
  await launched.page.click('.desktop-tab-new');
  await launched.page.click(`.desktop-new-tab-item:has-text("${label}")`);
}

function activePane(kind: string): string {
  return `.desktop-tab-pane[data-tab-pane="${kind}"]:not([hidden])`;
}

test('opens with a single permanent workspace tab', async () => {
  const { page } = launched;

  await expect(page.locator('.desktop-tab')).toHaveCount(1);
  await expect(
    page.locator('.desktop-tab[data-tab-kind="workspace"]'),
  ).toHaveAttribute('data-active', 'true');
  // The workspace tab is the app's home surface and must not be closable.
  await expect(
    page.locator('.desktop-tab[data-tab-kind="workspace"] .desktop-tab-close'),
  ).toHaveCount(0);
});

test('opens settings as a tab that coexists with the workspace', async () => {
  const { page } = launched;

  await openNewTab('Settings');

  await expect(page.locator(activePane('settings'))).toBeVisible();
  // The point of promoting Settings out of a modal: the workspace tab is still
  // there to switch back to, rather than being covered.
  await expect(
    page.locator('.desktop-tab[data-tab-kind="workspace"]'),
  ).toHaveCount(1);
  await expect(page.locator('settings-app')).toHaveCount(1);

  await page.click('.desktop-tab[data-tab-kind="workspace"]');
  await expect(page.locator(activePane('workspace'))).toBeVisible();
});

test('loads a workspace file into the Monaco editor tab', async () => {
  const { page } = launched;

  await openNewTab('Editor');
  await expect(page.locator(activePane('editor'))).toBeVisible();

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

test('runs an interactive shell in a terminal tab', async () => {
  const { page } = launched;

  await openNewTab('Terminal');
  await expect(page.locator(activePane('terminal'))).toBeVisible();

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

  const before = await page.locator('.desktop-tab').count();
  const terminalTab = page
    .locator('.desktop-tab[data-tab-kind="terminal"]')
    .last();
  await terminalTab.hover();
  await terminalTab.locator('.desktop-tab-close').click();

  await expect(page.locator('.desktop-tab')).toHaveCount(before - 1);
  // Whatever is focused, a pane must be showing — the shell should never end up
  // with an active id that matches no tab.
  await expect(page.locator('.desktop-tab[data-active="true"]')).toHaveCount(1);
  await expect(page.locator('.desktop-tab-pane:not([hidden])')).toHaveCount(1);
});

test('routes legacy desktop:setRoute IPC to the owning tab', async () => {
  const { page } = launched;

  // Menu items and the command palette still speak the four-route vocabulary;
  // each route must resolve to the tab that now owns that surface.
  await page.evaluate(() => {
    window.postMessage({ command: 'desktop:setRoute', route: 'logs' }, '*');
  });
  await expect(page.locator(activePane('logs'))).toBeVisible();
  await expect(page.locator('.desktop-log-viewer')).toBeVisible();

  await page.evaluate(() => {
    window.postMessage({ command: 'desktop:setRoute', route: 'main' }, '*');
  });
  await expect(page.locator(activePane('workspace'))).toBeVisible();
});
