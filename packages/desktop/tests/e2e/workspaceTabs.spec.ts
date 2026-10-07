import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type Locator } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';
import { cleanupDirectory } from './workspaceStorageFixture.js';

// Real offscreen Electron: exercise grid changes at resource boundaries, not
// screenshots of a mocked layout or implementation-shaped reducer assertions.
let launched: LaunchedApp;
let workspacePath: string;
const rendererErrors: string[] = [];
test.describe.configure({ mode: 'serial' });
const panel = (kind: string) =>
  launched.page.locator(
    `.shell-project-workbench:not([hidden]) .shell-dock-surface[data-kind="${kind}"]:visible`,
  );
const tab = (kind: string) =>
  launched.page.locator(
    `.shell-project-workbench:not([hidden]) .shell-dock-tab[data-kind="${kind}"]`,
  );

async function menu(group: Locator, value: string) {
  const dropdown = group.locator('.shell-dock-actions wa-dropdown');
  await dropdown.locator('wa-button[slot="trigger"]').click();
  await dropdown.locator(`wa-dropdown-item[value="${value}"]`).click();
}
function groupOf(tab: Locator) {
  return tab.locator(
    'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " dv-groupview ")]',
  );
}
async function openFile(name: string) {
  await launched.page.locator('#shellToggleSidePanel').click();
  await panel('files')
    .locator(`.desktop-editor-tree-row[data-path="${name}"]`)
    .click();
}
async function moveTab(
  source: Locator,
  destination: Locator,
  edge: 'right' | 'bottom' | 'center',
  inspectPreview = false,
) {
  const a = (await source.boundingBox())!;
  const b = (await destination.boundingBox())!;
  const targetGroup = (await groupOf(source).boundingBox())!;
  await launched.page.mouse.move(
    a.x + Math.min(a.width / 2, 45),
    a.y + a.height / 2,
  );
  await launched.page.mouse.down();
  await launched.page.mouse.move(a.x + 15, a.y + a.height + 15, { steps: 5 });
  const preview = launched.page.locator('.dv-drop-target-anchor:visible');
  if (inspectPreview) {
    // A tab leaving a group with another tab previews exactly the new group's
    // bounds. Inspect every side before committing a split, in both themes.
    for (const theme of ['light', 'dark'] as const) {
      await launched.page.emulateMedia({ colorScheme: theme });
      for (const side of ['left', 'top', 'right', 'bottom'] as const) {
        let x = b.x + b.width / 2;
        let y = b.y + b.height / 2;
        if (side === 'left') x = b.x + 32;
        if (side === 'right') x = b.x + b.width - 32;
        if (side === 'top') y = b.y + 32;
        if (side === 'bottom') y = b.y + b.height - 32;
        await launched.page.mouse.move(x, y, { steps: 8 });
        await expect(preview).toHaveCSS('border-top-style', 'solid');
        await expect(preview).not.toHaveCSS(
          'background-color',
          'rgba(0, 0, 0, 0)',
        );
        const r = (await preview.boundingBox())!;
        const horizontal = side === 'left' || side === 'right';
        expect(
          Math.abs(r.width - targetGroup.width / (horizontal ? 2 : 1)),
        ).toBeLessThan(2);
        expect(
          Math.abs(r.height - targetGroup.height / (horizontal ? 1 : 2)),
        ).toBeLessThan(2);
        expect(
          Math.abs(
            r.x -
              targetGroup.x -
              (side === 'right' ? targetGroup.width / 2 : 0),
          ),
        ).toBeLessThan(2);
        expect(
          Math.abs(
            r.y -
              targetGroup.y -
              (side === 'bottom' ? targetGroup.height / 2 : 0),
          ),
        ).toBeLessThan(2);
        expect(await groupOf(source).boundingBox()).toEqual(targetGroup);
      }
      await launched.page.screenshot({
        path: test.info().outputPath(`split-preview-${theme}.png`),
        animations: 'disabled',
      });
    }
  }
  await launched.page.mouse.move(
    edge === 'right' ? b.x + b.width - 32 : b.x + b.width / 2,
    edge === 'bottom' ? b.y + b.height - 32 : b.y + b.height / 2,
    { steps: 15 },
  );
  await expect(preview).toBeVisible();
  const previewBounds = (await preview.boundingBox())!;
  await launched.page.mouse.up();
  await expect(preview).toHaveCount(0);
  if (inspectPreview) {
    await expect
      .poll(async () => {
        const result = (await groupOf(source).boundingBox())!;
        return Object.entries(previewBounds).every(
          ([key, value]) =>
            Math.abs(result[key as keyof typeof result] - value) < 2,
        );
      })
      .toBe(true);
  }
}

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'texra-docking-e2e-'));
  writeFileSync(
    join(workspacePath, 'first.ts'),
    'export const firstDocument = true;\n',
  );
  writeFileSync(
    join(workspacePath, 'second.ts'),
    'export const secondDocument = true;\n',
  );
  launched = await launchTexraApp({ workspacePath });
  launched.page.on('pageerror', (error) => rendererErrors.push(error.message));
  await dismissOnboarding(launched.page);
});

test.afterAll(async () => {
  if (launched) await closeTexraApp(launched);
  if (workspacePath) cleanupDirectory(workspacePath);
  expect(rendererErrors).toEqual([]);
});

test('splits in both directions, keeps the explorer and agent, and restores the grid', async () => {
  const { page, app } = launched;
  await expect(panel('agent').locator('session-composer')).toBeVisible();
  await openFile('first.ts');
  await expect(panel('editor').locator('.view-lines')).toContainText(
    'firstDocument',
  );
  await expect(panel('files')).toBeVisible();
  await expect(panel('agent')).toBeVisible();
  const treeBounds = await panel('files').boundingBox();
  await openFile('second.ts');
  await expect(panel('editor').locator('.view-lines')).toContainText(
    'secondDocument',
  );
  expect(await panel('files').boundingBox()).toEqual(treeBounds);
  const second = page.locator(
    '.shell-dock-tab[data-tab-id="workbench:editor:second.ts"]',
  );
  await moveTab(second, panel('editor'), 'bottom', true);
  await expect(panel('editor')).toHaveCount(2);
  const editors = panel('editor');
  const editorBoxes = await editors.evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
  expect(Math.abs(editorBoxes[0]!.x - editorBoxes[1]!.x)).toBeLessThan(2);
  expect(Math.abs(editorBoxes[0]!.y - editorBoxes[1]!.y)).toBeGreaterThan(100);
  const first = page.locator(
    '.shell-dock-tab[data-tab-id="workbench:editor:first.ts"]',
  );
  await moveTab(
    second,
    page.locator(
      '.shell-dock-editor[data-panel-id="workbench:editor:first.ts"]:visible',
    ),
    'right',
  );
  await expect
    .poll(async () => {
      const a = (await groupOf(first).boundingBox())!;
      const b = (await groupOf(second).boundingBox())!;
      return Math.abs(a.y - b.y) < 2 && b.x > a.x + 100;
    })
    .toBe(true);
  // A right-click uses viewport coordinates even inside an offset split group.
  const clickedTab = (await first.boundingBox())!;
  const clickPoint = {
    x: clickedTab.x + 12,
    y: clickedTab.y + clickedTab.height / 2,
  };
  await page.mouse.click(clickPoint.x, clickPoint.y, { button: 'right' });
  const contextMenu = page.locator('.shell-dock-tab-menu[open]');
  await expect(contextMenu.getByRole('menu')).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = (await contextMenu.getByRole('menu').boundingBox())!;
      return Math.abs(bounds.x - clickPoint.x);
    })
    .toBeLessThan(2);
  await expect
    .poll(async () => {
      const bounds = (await contextMenu.getByRole('menu').boundingBox())!;
      return Math.abs(bounds.y - clickPoint.y);
    })
    .toBeLessThan(3);
  await page.screenshot({
    path: test.info().outputPath('tab-context-menu.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  // Return the second tab through its keyboard-accessible context menu.
  await second.locator('xpath=..').focus();
  await page.keyboard.press('Shift+F10');
  const moveChoice = page
    .locator('.shell-dock-tab-menu[open]')
    .locator('wa-dropdown-item')
    .filter({ hasText: 'Move to first.ts' });
  await moveChoice.click();
  await expect(panel('editor')).toHaveCount(1);
  await expect(
    groupOf(first).locator('.shell-dock-tab[data-kind="editor"]'),
  ).toHaveCount(2);
  await menu(groupOf(second), 'split-below');
  await expect(panel('editor')).toHaveCount(2);
  // The outer edge makes a full-height column alongside the whole workspace,
  // independently of the nested editor split under the pointer.
  const workspace = (await page.locator('.shell-dock:visible').boundingBox())!;
  const sourceTab = (await second.boundingBox())!;
  await page.mouse.move(sourceTab.x + 24, sourceTab.y + sourceTab.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    workspace.x + workspace.width - 6,
    workspace.y + workspace.height / 2,
    { steps: 20 },
  );
  const columnPreview = page.locator('.dv-drop-target-anchor:visible');
  await expect(columnPreview).toBeVisible();
  const columnBounds = (await columnPreview.boundingBox())!;
  expect(columnBounds.width).toBeGreaterThan(160);
  expect(Math.abs(columnBounds.height - workspace.height)).toBeLessThan(2);
  await page.screenshot({
    path: test.info().outputPath('column-preview.png'),
    animations: 'disabled',
  });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const result = (await groupOf(second).boundingBox())!;
      return Object.entries(columnBounds).every(
        ([key, value]) =>
          Math.abs(result[key as keyof typeof result] - value) < 2,
      );
    })
    .toBe(true);
  // Resize the actual sash and keep this grid across a reload.
  const sash = page.locator('.shell-dock .dv-sash.dv-enabled:visible').first();
  const bounds = (await sash.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width / 2 + 40,
    bounds.y + bounds.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.screenshot({
    path: test.info().outputPath('docked-workspace.png'),
    animations: 'disabled',
  });
  const before = await panel('editor').evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
  await page.reload();
  await expect(panel('editor')).toHaveCount(2);
  await expect
    .poll(async () => {
      const after = await panel('editor').evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
      return after.every((r, i) =>
        Object.entries(r).every(
          ([key, value]) =>
            Math.abs(value - before[i]![key as keyof typeof r]) < 3,
        ),
      );
    })
    .toBe(true);
  await expect(panel('agent')).toBeVisible();
  // New task reveals Agent without disturbing document groups.
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(panel('agent').locator('session-composer')).toBeVisible();
  await expect(panel('editor')).toHaveCount(2);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setSize(960, 760),
  );
  await expect(panel('editor')).toHaveCount(2);
  await page.screenshot({
    path: test.info().outputPath('docked-compact.png'),
    animations: 'disabled',
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setSize(1280, 860),
  );
});

test('moves live terminals and unsaved editors without recreating resources', async () => {
  const { page, app } = launched;
  const first = page.locator(
    '.shell-dock-tab[data-tab-id="workbench:editor:first.ts"]',
  );
  const source = page.locator(
    '.shell-dock-editor[data-panel-id="workbench:editor:first.ts"]:visible',
  );
  await source.locator('.view-line').first().click();
  const platform = await app.evaluate(() => process.platform);
  const mod = platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('// retained edit');
  await expect(source.locator('.view-lines')).toContainText('retained edit');
  const editorNode = await source.locator('.monaco-editor').elementHandle();
  await page.locator('#shellToggleTerminalPanel').click();
  const terminal1 = tab('terminal').first();
  const terminalSurface1 = page.locator(
    '.shell-dock-terminal[data-panel-id="workbench:terminal:1"] .desktop-terminal-surface',
  );
  const pidPath = join(workspacePath, 'terminal.pid');
  await terminalSurface1.locator('.xterm').click();
  await page.keyboard.type(`printf '%s' "$$" > '${pidPath}'`);
  await page.keyboard.press('Enter');
  await expect
    .poll(() => existsSync(pidPath) && readFileSync(pidPath, 'utf8').trim())
    .toMatch(/^\d+$/);
  const pid = Number(readFileSync(pidPath, 'utf8'));
  const terminalNode = await terminalSurface1.elementHandle();
  await page.locator('#shellToggleTerminalPanel').click();
  await expect(tab('terminal')).toHaveCount(1);
  await menu(groupOf(terminal1), 'terminal');
  const terminal2 = tab('terminal').last();
  await menu(groupOf(terminal2), 'split-right');
  await expect(panel('terminal')).toHaveCount(2);
  expect(await terminalNode?.evaluate((node) => node.isConnected)).toBe(true);
  expect(process.kill(pid, 0)).toBe(true);
  await moveTab(first, panel('agent'), 'right');
  expect(await editorNode?.evaluate((node) => node.isConnected)).toBe(true);
  await expect(
    page.locator(
      '.shell-dock-editor[data-panel-id="workbench:editor:first.ts"]:visible .view-lines',
    ),
  ).toContainText('retained edit');
  await page
    .locator(
      '.shell-dock-editor[data-panel-id="workbench:editor:first.ts"]:visible .view-line',
    )
    .first()
    .click();
  await page.keyboard.press(`${mod}+z`);
  await expect(
    page.locator(
      '.shell-dock-editor[data-panel-id="workbench:editor:first.ts"]:visible .view-lines',
    ),
  ).not.toContainText('retained edit');
  await page.keyboard.press(`${mod}+s`);
  // Closing one PTY releases only that session.
  await terminal1.locator('.shell-dock-tab-close wa-button').click();
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  await expect(panel('terminal')).toHaveCount(1);
});

test('keeps browser menus above native content and close controls inside tab bounds', async () => {
  const { page, app } = launched;
  const attachedViews = () =>
    app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.contentView.children.length,
    );
  const baseline = await attachedViews();
  await menu(groupOf(tab('editor').first()), 'browser');
  await expect.poll(attachedViews).toBe(baseline + 1);
  const browser = tab('browser');
  await expect(browser).toBeVisible();
  const close = browser.locator('.shell-dock-tab-close wa-button');
  await expect
    .poll(async () =>
      close.evaluate((element) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return element === hit || element.contains(hit);
      }),
    )
    .toBe(true);
  const dropdown = groupOf(browser).locator('.shell-dock-actions wa-dropdown');
  await dropdown.locator('wa-button[slot="trigger"]').click();
  await expect(
    dropdown.locator('wa-dropdown-item[value="terminal"]'),
  ).toBeVisible();
  await expect.poll(attachedViews).toBe(baseline);
  await page.screenshot({
    path: test.info().outputPath('browser-group-menu.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect.poll(attachedViews).toBe(baseline + 1);
  await close.click();
  await expect.poll(attachedViews).toBe(baseline);
});

test('preserves each project’s grid and unsaved editor when switching projects', async () => {
  const { page, app } = launched;
  const otherPath = mkdtempSync(join(tmpdir(), 'texra-dock-other-'));
  writeFileSync(
    join(otherPath, 'first.ts'),
    'export const otherProject = true;\n',
  );
  const activeRow = page.locator('.shell-project-row[aria-current="true"]');
  const projectA = (await activeRow.getAttribute('title'))!;
  await openFile('first.ts');
  const editorA = panel('editor').filter({
    has: page.locator('[title="first.ts"]'),
  });
  await editorA.locator('.view-line').first().click();
  await page.keyboard.type('// project A draft ');
  await expect(editorA.locator('.view-lines')).toContainText('project A draft');
  const retained = await editorA.locator('.monaco-editor').elementHandle();
  const groupCount = await page
    .locator('.shell-project-workbench:not([hidden]) .dv-groupview')
    .count();
  try {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, otherPath);
    await page
      .getByRole('button', { name: 'Open project folder', exact: true })
      .click();
    await expect(page.locator('.shell-project-row')).toHaveCount(2);
    const projectB = (await activeRow.getAttribute('title'))!;
    expect(projectB).not.toBe(projectA);
    await expect(panel('agent')).toBeVisible();
    await expect(tab('terminal')).toHaveCount(0);
    await openFile('first.ts');
    await expect(panel('editor').locator('.view-lines')).toContainText(
      'otherProject',
    );
    // An explicit command addressed to an offscreen project still runs there.
    const commandOutput = join(workspacePath, 'background-command.txt');
    await page.evaluate(
      ({ session, initialCommand }) => {
        window.postMessage(
          { command: 'desktop:terminal:openCommand', session, initialCommand },
          '*',
        );
      },
      {
        session: projectA,
        initialCommand: `printf background > '${commandOutput}'`,
      },
    );
    await expect
      .poll(
        () => existsSync(commandOutput) && readFileSync(commandOutput, 'utf8'),
      )
      .toBe('background');
    await expect(activeRow).toHaveAttribute('title', projectB);
    await page.locator(`.shell-project-row[title="${projectA}"]`).click();
    await expect(
      panel('editor').filter({ hasText: 'project A draft' }),
    ).toBeVisible();
    expect(await retained?.evaluate((node) => node.isConnected)).toBe(true);
    await expect(
      page.locator('.shell-project-workbench:not([hidden]) .dv-groupview'),
    ).toHaveCount(groupCount);
    const platform = await app.evaluate(() => process.platform);
    await panel('editor')
      .filter({ hasText: 'project A draft' })
      .locator('.view-line')
      .first()
      .click();
    await page.keyboard.press(platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.keyboard.press(platform === 'darwin' ? 'Meta+s' : 'Control+s');
  } finally {
    cleanupDirectory(otherPath);
  }
});
