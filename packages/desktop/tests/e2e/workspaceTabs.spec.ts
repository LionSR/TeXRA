import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
// while workbench tabs can live in independently resizable Right and Bottom
// panes. The task-shell reducer is unit-tested separately; this suite checks the
// wiring that unit tests cannot reach — that movable tabs mount their panes,
// Monaco loads a real file from disk, and a pty produces output.

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
  mkdirSync(join(workspacePath, 'src', 'components'), { recursive: true });
  writeFileSync(
    join(workspacePath, 'src', 'components', 'Panel.ts'),
    'export class Panel {}\n',
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
  const sourceDirectory = page.locator(
    '.desktop-editor-tree-row[data-kind="directory"][data-path="src"]',
  );
  await expect(sourceDirectory).toBeVisible();
  await expect(
    page.locator(
      '.desktop-editor-tree-row[data-kind="directory"][data-path="src/components"]',
    ),
  ).not.toBeVisible();
  await sourceDirectory.click();
  const componentsDirectory = page.locator(
    '.desktop-editor-tree-row[data-kind="directory"][data-path="src/components"]',
  );
  await expect(componentsDirectory).toBeVisible();
  await componentsDirectory.click();
  const nestedFile = page.locator(
    '.desktop-editor-tree-row[data-kind="file"][data-path="src/components/Panel.ts"]',
  );
  await expect(nestedFile).toBeVisible();
  await expect(nestedFile.locator('.desktop-editor-tree-label')).toHaveText(
    'Panel.ts',
  );
  await expect(
    page.locator('.desktop-editor-tree-empty:has-text("No files found")'),
  ).toHaveCount(0);
});

test('resizes the window canvas, project sidebar, and project/task sections', async () => {
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

  await page.locator('.task-sidebar-scroll').evaluate(async (element) => {
    await (element as HTMLElement & { updateComplete: Promise<unknown> })
      .updateComplete;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  const projectDividerY = (): Promise<number> =>
    page.locator('.task-sidebar-scroll').evaluate((element) => {
      const divider = element.shadowRoot?.querySelector('[part~="divider"]');
      if (!(divider instanceof HTMLElement)) {
        throw new Error('Project/Tasks divider was not rendered.');
      }
      return divider.getBoundingClientRect().y;
    });
  const initialSectionDividerY = await projectDividerY();

  await page
    .locator('.task-sidebar-scroll > [part~="divider"]')
    .first()
    .focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect
    .poll(projectDividerY)
    .toBeGreaterThan(initialSectionDividerY + 40);
  await expect(page.locator('.task-history-section')).toBeVisible();
});

test('aligns titlebar content and keeps the collapsed toggle clear of macOS controls', async () => {
  const { app, page } = launched;
  const brand = await page.locator('.task-sidebar-brand').boundingBox();
  const brandLogo = await page.locator('.task-sidebar-logo').boundingBox();
  const taskHeader = await page.locator('.task-header').boundingBox();
  expect(brand).not.toBeNull();
  expect(brandLogo).not.toBeNull();
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
    expect(brandLogo?.x).toBeGreaterThanOrEqual(92);
    expect(toggleBounds?.x).toBeGreaterThanOrEqual(92);
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

test('toggles and restores the bottom, side, and summary bars', async () => {
  const { page } = launched;

  await openSidebarWorkbench('Settings');
  const bottomToggle = page.locator('#taskToggleBottomBar');
  const sideToggle = page.locator('#taskToggleSidePanel');
  const summaryToggle = page.locator('#taskToggleSummaryBar');

  await expect(bottomToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(sideToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(summaryToggle).toHaveAttribute('aria-pressed', 'true');

  await bottomToggle.click();
  const bottomWorkbench = page.locator(
    '.task-workbench[data-placement="bottom"]',
  );
  await expect(bottomWorkbench).toBeVisible();
  await expect(page.locator(activeWorkbenchTab('terminal'))).toBeVisible();
  await expect(bottomToggle).toHaveAttribute('aria-pressed', 'true');

  const initialBottomHeight = (await bottomWorkbench.boundingBox())?.height;
  expect(initialBottomHeight).toBeDefined();
  if (initialBottomHeight != null) {
    const divider = page.locator('.task-bottom-split [part="divider"]').first();
    await divider.focus();
    await page.keyboard.press('Shift+ArrowUp');
    await expect
      .poll(async () => (await bottomWorkbench.boundingBox())?.height ?? 0)
      .toBeGreaterThan(initialBottomHeight + 40);
  }

  await bottomToggle.click();
  await expect(bottomWorkbench).toHaveCount(0);
  await expect(bottomToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.task-sidebar-footer')).toBeVisible();

  await summaryToggle.click();
  await expect(page.locator('.task-environment-button')).toHaveCount(0);
  await expect(summaryToggle).toHaveAttribute('aria-pressed', 'false');
  await summaryToggle.click();
  await expect(page.locator('.task-environment-button')).toBeVisible();

  await sideToggle.click();
  await expect(page.locator('.task-workbench')).toHaveCount(0);
  await expect(sideToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(sideToggle).toBeVisible();
  await sideToggle.click();
  await expect(page.locator(activeWorkbenchTab('settings'))).toBeVisible();
  await expect(sideToggle).toHaveAttribute('aria-pressed', 'true');
});

test('moves tabs between Bottom and Right from the context menu', async () => {
  const { page } = launched;
  const bottomToggle = page.locator('#taskToggleBottomBar');

  await bottomToggle.click();
  const terminalTab = page.locator(activeWorkbenchTab('terminal'));
  await expect(terminalTab).toBeVisible();
  await expect(
    terminalTab.locator('xpath=ancestor::aside[@data-placement="bottom"]'),
  ).toBeVisible();

  await terminalTab.click({ button: 'right' });
  const contextMenu = terminalTab.locator('.task-workbench-tab-menu');
  await expect(contextMenu).toHaveAttribute('open', '');
  await contextMenu.locator('wa-dropdown-item[value="move-right"]').click();
  await expect(
    terminalTab.locator('xpath=ancestor::aside[@data-placement="right"]'),
  ).toBeVisible();
  await expect(page.locator('.task-bottom-split')).toHaveCount(0);

  await terminalTab.click({ button: 'right' });
  await terminalTab.locator('wa-dropdown-item[value="move-bottom"]').click();
  await expect(
    terminalTab.locator('xpath=ancestor::aside[@data-placement="bottom"]'),
  ).toBeVisible();
  await expect(page.locator(activeWorkbenchTab('settings'))).toBeVisible();

  await openSidebarWorkbench('Terminal');
  const bottomTabs = page.locator(
    '.task-workbench[data-placement="bottom"] .task-workbench-tab',
  );
  const countBeforeContextClose = await bottomTabs.count();
  const closeCandidate = page.locator(activeWorkbenchTab('terminal'));
  await closeCandidate.click({ button: 'right' });
  await closeCandidate.locator('wa-dropdown-item[value="close"]').click();
  await expect(bottomTabs).toHaveCount(countBeforeContextClose - 1);
});

test('loads tools, centers every compact nav icon, and customizes shortcuts', async () => {
  const { app, page } = launched;

  await openSidebarWorkbench('Settings');
  const workbenchSplit = page.locator('.task-main-split');
  await workbenchSplit.evaluate((element) => {
    const split = element as HTMLElement & { positionInPixels: number };
    split.positionInPixels = 440;
    split.dispatchEvent(new CustomEvent('wa-reposition', { bubbles: true }));
  });
  await expect
    .poll(async () => {
      const bounds = await page.locator('settings-app').boundingBox();
      return bounds?.width ?? Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(520);

  await page.evaluate(() => {
    window.postMessage({ command: 'setTab', tabIndex: 5 }, '*');
  });
  await expect(page.locator('tools-tab tool-card').first()).toBeVisible({
    timeout: 5_000,
  });

  const alignments = await page.evaluate(() => {
    const root = document.querySelector('settings-app')?.shadowRoot;
    const buttons =
      root?.querySelectorAll<HTMLElement>('.settings-page-button') ?? [];
    return [...buttons].map((button) => {
      const base =
        button.shadowRoot?.querySelector<HTMLElement>('[part~="base"]');
      const icon = button.querySelector<HTMLElement>('.settings-tab-icon');
      const label =
        button.shadowRoot?.querySelector<HTMLElement>('[part~="label"]');
      if (!base || !icon || !label) {
        throw new Error('Compact settings navigation was not mounted.');
      }
      const baseRect = base.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      return {
        labelDisplay: getComputedStyle(label).display,
        horizontalOffset:
          (iconRect.left + iconRect.right - baseRect.left - baseRect.right) / 2,
        verticalOffset:
          (iconRect.top + iconRect.bottom - baseRect.top - baseRect.bottom) / 2,
      };
    });
  });
  expect(alignments.length).toBeGreaterThan(0);
  for (const alignment of alignments) {
    expect(alignment.labelDisplay).toBe('none');
    expect(Math.abs(alignment.horizontalOffset)).toBeLessThanOrEqual(1);
    expect(Math.abs(alignment.verticalOffset)).toBeLessThanOrEqual(1);
  }

  await page.evaluate(() => {
    window.postMessage({ command: 'setTab', tabIndex: 11 }, '*');
  });
  const shortcuts = page.locator('shortcuts-tab');
  await expect(
    shortcuts.getByText('Toggle Bottom Bar', { exact: true }),
  ).toBeVisible();
  await expect(
    shortcuts.getByText('Toggle Side Panel', { exact: true }),
  ).toBeVisible();
  await expect(
    shortcuts.getByText('Toggle Summary Bar', { exact: true }),
  ).toBeVisible();
  const recorder = page.locator('shortcuts-tab .shortcut-recorder').first();
  await expect(recorder).toBeVisible();
  await recorder.click();
  const platform = await app.evaluate(() => process.platform);
  const customShortcut =
    platform === 'darwin' ? 'Meta+Shift+J' : 'Control+Shift+J';
  await page.keyboard.press(customShortcut);
  await expect(recorder).toContainText(
    platform === 'darwin' ? '⌘⇧J' : 'Ctrl+Shift+J',
  );

  await page.locator('.task-header-title').click();
  await page.keyboard.press(customShortcut);
  await expect(
    page.locator('wa-dialog.desktop-command-palette'),
  ).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
});

test('keeps settings banners consistent in a narrow side panel', async () => {
  const { page } = launched;
  const bannerTabs = [
    { index: 0, tag: 'memory-tab' },
    { index: 2, tag: 'models-tab' },
    { index: 4, tag: 'multi-agent-tab' },
    { index: 9, tag: 'goal-tab' },
  ] as const;
  const bannerMetrics: Array<{
    readonly borderRadius: string;
    readonly iconSize: string;
    readonly padding: string;
    readonly titleWeight: string;
  }> = [];

  await openSidebarWorkbench('Settings');
  for (const tab of bannerTabs) {
    await page.evaluate((tabIndex) => {
      window.postMessage({ command: 'setTab', tabIndex }, '*');
    }, tab.index);

    const banner = page.locator(`${tab.tag} .settings-banner`).first();
    await expect(banner).toBeVisible();
    await expect
      .poll(() =>
        banner.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      )
      .toBe(true);

    bannerMetrics.push(
      await banner.evaluate((element) => {
        const callout = element.querySelector('wa-callout');
        const icon = element.querySelector('wa-icon[slot="icon"]');
        const title = element.querySelector('.settings-banner-title');
        if (
          !(callout instanceof HTMLElement) ||
          !(icon instanceof HTMLElement) ||
          !(title instanceof HTMLElement)
        ) {
          throw new Error('Shared settings banner chrome was not rendered.');
        }
        const calloutStyle = getComputedStyle(callout);
        return {
          borderRadius: calloutStyle.borderRadius,
          iconSize: getComputedStyle(icon).fontSize,
          padding: calloutStyle.padding,
          titleWeight: getComputedStyle(title).fontWeight,
        };
      }),
    );
  }

  expect(new Set(bannerMetrics.map((metric) => metric.borderRadius)).size).toBe(
    1,
  );
  expect(new Set(bannerMetrics.map((metric) => metric.iconSize)).size).toBe(1);
  expect(new Set(bannerMetrics.map((metric) => metric.padding)).size).toBe(1);
  expect(new Set(bannerMetrics.map((metric) => metric.titleWeight)).size).toBe(
    1,
  );
});

test('shows live environment status without duplicate panel actions', async () => {
  const { page } = launched;

  await page.locator('.task-environment-button').click();
  const popover = page.locator('.task-environment-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Environment');
  await expect(popover).toContainText('Changes');
  await expect(popover).toContainText('Background terminal');
  await expect(popover).toContainText('No open sources');
  await expect(popover.locator('wa-button')).toHaveCount(1);
  await expect(popover.locator('.task-environment-refresh')).not.toBeDisabled();
  await page.locator('.task-environment-button').click();
});

test('loads a workspace file into the Monaco editor workbench', async () => {
  const { page } = launched;

  const latexRow = page.locator(
    '.desktop-editor-tree-row[data-path="sample.tex"]',
  );
  const typescriptRow = page.locator(
    '.desktop-editor-tree-row[data-path="sample.ts"]',
  );
  await expect(latexRow).toBeVisible({ timeout: 15_000 });
  await expect(typescriptRow).toBeVisible();

  // Hit the cold Monaco path with two immediate selections. Both requests
  // share one editor load, and the last click must remain the visible model
  // even if the first file read resolves later.
  await latexRow.click();
  await typescriptRow.click();
  await expect(page.locator(activeWorkbenchTab('editor'))).toBeVisible();
  await expect(page.locator(activeWorkbenchTab('editor'))).toContainText(
    'sample.ts',
  );
  await expect(
    page.locator('.desktop-editor-surface .view-lines'),
  ).toContainText('projectTreeLoaded', { timeout: 20_000 });

  await latexRow.click();
  await expect(
    page.locator('.desktop-editor-surface .view-lines'),
  ).toContainText('documentclass', { timeout: 20_000 });
});

test('reloads a clean cached editor model after an external file change', async () => {
  const { page } = launched;
  const typescriptRow = page.locator(
    '.desktop-editor-tree-row[data-path="sample.ts"]',
  );
  const latexRow = page.locator(
    '.desktop-editor-tree-row[data-path="sample.tex"]',
  );

  await typescriptRow.click();
  await expect(
    page.locator('.desktop-editor-surface .view-lines'),
  ).toContainText('projectTreeLoaded', { timeout: 20_000 });

  writeFileSync(
    join(workspacePath, 'sample.tex'),
    '\\documentclass{article}\n\\begin{document}\nexternal update\n\\end{document}\n',
    'utf8',
  );
  await latexRow.click();

  await expect(
    page.locator('.desktop-editor-surface .view-lines'),
  ).toContainText('external update', { timeout: 20_000 });
});

test('runs an interactive shell in a terminal workbench tab', async () => {
  const { page } = launched;

  await openSidebarWorkbench('Terminal');
  const terminalTab = page.locator(activeWorkbenchTab('terminal'));
  await expect(terminalTab).toBeVisible();
  await expect(
    terminalTab.locator('xpath=ancestor::aside[@data-placement="bottom"]'),
  ).toBeVisible();

  // xterm renders rows into .xterm-rows. A prompt appearing at all proves the
  // pty spawned, node-pty loaded under Electron's ABI, and output streamed back
  // through IPC.
  const terminalSurface = terminalTab
    .locator('xpath=ancestor::aside[@data-placement="bottom"]')
    .locator('.desktop-terminal-surface:not([hidden])');
  const rows = terminalSurface.locator('.xterm-rows');
  await expect(rows).toBeVisible({ timeout: 20_000 });
  await expect(rows).not.toBeEmpty({ timeout: 20_000 });

  // Echo a unique token to confirm keystrokes reach the shell.
  await terminalSurface.locator('.xterm').click();
  await page.keyboard.type('echo texra-pty-ok');
  await page.keyboard.press('Enter');
  await expect(rows).toContainText('texra-pty-ok', { timeout: 20_000 });
});

test('closes a bottom tab and falls back within the same pane', async () => {
  const { page } = launched;

  // Establish two terminal tabs in Bottom so the fallback cannot accidentally
  // select a tab from Right.
  await openSidebarWorkbench('Terminal');
  await openSidebarWorkbench('Terminal');

  const tabs = page.locator(
    '.task-workbench[data-placement="bottom"] .task-workbench-tab',
  );
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
      '.task-workbench[data-placement="bottom"] .task-workbench-tab[data-active="true"] .task-workbench-tab-label',
    ),
  ).toHaveText(fallbackLabel);
  await expect(
    page.locator(
      '.task-workbench[data-placement="bottom"] .task-workbench-pane',
    ),
  ).toBeVisible();
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
