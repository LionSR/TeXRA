import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  box,
  chooseDesktopTheme,
  closeTexraApp,
  createProfile,
  dismissOnboarding,
  expect,
  findWorkspaceStoragePath,
  launchTexraApp,
  openDesktopAppearance,
  openWorkbench,
  removeProfile,
  resizeWindow,
  setSettingsTab,
  showLauncher,
  test,
  type LaunchedApp,
  type Profile,
} from './electronApp.js';

/**
 * Standalone-trajectory audit suite: one launch walks the critical user
 * journeys identified in issue #3643 (workspace open, settings, the
 * workbenches) and asserts the renderer surfaces a sane UI for each.
 * `screenshots.spec.ts` captures the same surfaces for visual review.
 */

const MEMORY_FILE_NAME = 'trajectory-memory.md';
const MEMORY_TEXT = 'A memory the Memory tab lists for this project.';

let profile: Profile;
let launched: LaunchedApp;

test.beforeAll(async () => {
  profile = createProfile();
  // A memory file in the project's storage, for the Memory tab to list.
  const memories = join(await findWorkspaceStoragePath(profile), 'memories');
  mkdirSync(memories, { recursive: true });
  writeFileSync(join(memories, MEMORY_FILE_NAME), `${MEMORY_TEXT}\n`);
  launched = await launchTexraApp(profile);
  // Dismiss the first-run walkthrough so it doesn't intercept clicks.
  await dismissOnboarding(launched.page);
  // The app opens the project the profile remembers, under its name.
  await expect(
    launched.page.locator('.shell-project-name').first(),
  ).toContainText(basename(profile.workspacePath));
});

// The Settings popup is modal; a journey that opened it must not leave it
// over the next one's clicks.
test.afterEach(async () => {
  // `open = false` only starts the hide animation; wait until it has left
  // the top layer.
  await launched.page.evaluate(async () => {
    const dialog = document.querySelector<HTMLElement & { open: boolean }>(
      'wa-dialog.desktop-settings-overlay',
    );
    if (!dialog?.open) return;
    const hidden = new Promise<void>((resolve) => {
      const onHide = (event: Event) => {
        if (event.target !== dialog) return;
        dialog.removeEventListener('wa-after-hide', onHide);
        resolve();
      };
      dialog.addEventListener('wa-after-hide', onHide);
    });
    dialog.open = false;
    await hidden;
  });
});

test.afterAll(async () => {
  await closeTexraApp(launched);
  await removeProfile(profile);
  expect(launched.rendererErrors).toEqual([]);
});

test('approval menu shows the current policy and keeps selection marks inside its rows', async () => {
  const { page } = launched;
  for (const [value, label] of [
    ['never', 'Block'],
    ['ask', 'Ask'],
    ['yolo', 'Auto-approve'],
  ] as const) {
    await setSettingsTab(launched, 'general');
    await page.locator('[data-section="approval"]').click();
    const policy = page.locator('#texra-approval-policy');
    await policy.locator(`wa-radio[value="${value}"]`).click();
    await expect(policy).toHaveJSProperty('value', value);
    await page.locator('.desktop-settings-close').click();
    await showLauncher(launched);
    const trigger = page.locator('#composer-approval');
    await expect(trigger).toContainText(label);
    await trigger.click();
    const selected = page.locator(
      'session-composer wa-dropdown-item[value="approval:policy"]',
    );
    await expect(selected).toBeVisible();
    await expect(selected).toHaveJSProperty('checked', true);
    await expect(selected).toContainText(`Use settings · ${label}`);
    const contained = await selected.evaluate((item) => {
      const check = item.shadowRoot?.querySelector('#check');
      if (!check) throw new Error('The selection mark was not rendered.');
      const row = item.getBoundingClientRect();
      const mark = check.getBoundingClientRect();
      return mark.left >= row.left && mark.right <= row.right;
    });
    expect(contained).toBe(true);
    await expect(
      page.locator('wa-dropdown-item[value="approval:autoApprove"]'),
    ).toHaveJSProperty('disabled', value === 'never');
    await page.screenshot({
      path: test.info().outputPath(`approval-${value}.png`),
    });
    await page.keyboard.press('Escape');
  }
  // The same shared gutter applies to other checkbox menus at narrow widths.
  await resizeWindow(launched, 760, 700);
  await page.locator('#composer-agent').click();
  const selectedAgent = page
    .locator('session-composer')
    .getByRole('menuitemcheckbox', { name: 'orchestrator', exact: true });
  await expect(selectedAgent).toBeVisible();
  await expect(selectedAgent).toHaveJSProperty('checked', true);
  expect(
    await selectedAgent.evaluate((item) => {
      const check = item.shadowRoot?.querySelector('#check');
      if (!check) throw new Error('The selection mark was not rendered.');
      const row = item.getBoundingClientRect();
      const mark = check.getBoundingClientRect();
      return mark.left >= row.left && mark.right <= row.right;
    }),
  ).toBe(true);
  await selectedAgent.click();
  await page.locator('#composer-agent').click();
  await expect(selectedAgent).toHaveJSProperty('checked', true);
  await page.screenshot({
    path: test.info().outputPath('agent-menu-narrow.png'),
  });
  await page.keyboard.press('Escape');
  await resizeWindow(launched, 1280, 800);
});

/**
 * Trajectory 3 — the Memory tab lists the project's memory files, and a
 * file's contents open under it.
 */
test('the Memory tab lists a memory file of the project', async () => {
  await setSettingsTab(launched, 'memory');
  const item = launched.page
    .locator('memory-item')
    .filter({ hasText: `/memories/${MEMORY_FILE_NAME}` });
  await expect(item).toHaveCount(1);
  await item.getByText('Contents', { exact: true }).click();
  await expect(item).toContainText(MEMORY_TEXT);
});

/**
 * Trajectory 4 — Logs view: ensure the Logs workbench renders the desktop log
 * viewer skeleton (header + actions). The actual log content is async and
 * may be empty on a fresh run, so we only assert structural surfaces.
 */
test('logs workbench renders the desktop log viewer', async () => {
  await openWorkbench(launched, 'logs');
  const header = launched.page.locator('.desktop-log-viewer-header');
  await expect(header).toBeVisible();
  // Header has Refresh / Copy / Export / Open Folder buttons.
  const actions = launched.page.locator(
    '.desktop-log-viewer-actions wa-button',
  );
  await expect(actions).toHaveCount(4);

  await launched.page.evaluate(() => {
    window.postMessage(
      {
        command: 'desktop:setLog',
        log: {
          path: '/tmp/texra-desktop.log',
          text: JSON.stringify({
            level: 'INFO',
            timestamp: '2026-07-26T12:00:00.000Z',
            message: 'Geometry check',
          }),
          truncated: false,
        },
      },
      '*',
    );
  });
  const infoSurface = launched.page
    .locator('.desktop-log-entry[data-level="info"]')
    .filter({ hasText: 'Geometry check' })
    .locator('.desktop-log-entry-level-icon');
  await expect(infoSurface).toBeVisible();
  const iconOffset = await infoSurface.evaluate((surface) => {
    const icon = surface.querySelector<HTMLElement>('wa-icon');
    const svg = icon?.shadowRoot?.querySelector<SVGElement>('svg');
    if (!icon || !svg) throw new Error('Log info icon was not rendered.');
    const surfaceRect = surface.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const centerOffset = (rect: DOMRect) => ({
      x:
        (rect.left + rect.right) / 2 -
        (surfaceRect.left + surfaceRect.right) / 2,
      y:
        (rect.top + rect.bottom) / 2 -
        (surfaceRect.top + surfaceRect.bottom) / 2,
    });
    return {
      host: centerOffset(iconRect),
      svg: centerOffset(svgRect),
    };
  });
  expect(iconOffset).toEqual({
    host: { x: 0, y: 0 },
    svg: { x: 0, y: 0 },
  });
  // Closed from its own tab, so the next workbench has the dock.
  const logsTab = launched.page.locator('.shell-dock-tab[data-kind="logs"]');
  await logsTab.locator('.shell-dock-tab-close wa-button').click();
  await expect(logsTab).toHaveCount(0);
});

/**
 * Trajectory 18 — in-app Review workbench.
 *
 * `desktopDiffHost` posts `desktop:showDiff` to the renderer; the renderer
 * opens a persistent Review tab containing `<texra-diff-view>` and a changed
 * file tree. We simulate the IPC by `window.postMessage`-ing the same payload
 * and assert the workbench opens and shows the supplied title and both sides
 * of the change.
 */
test('desktop:showDiff opens the in-app Review workbench', async () => {
  const payload = {
    command: 'desktop:showDiff',
    previewId: 'trajectory-review',
    title: 'Compare paper.tex',
    displayPath: 'paper.tex',
    originalText: '\\documentclass{article}\nold body\n',
    proposedText: '\\documentclass{article}\nnew body\n',
    additions: 1,
    deletions: 1,
    language: 'latex',
  };

  await launched.page.evaluate((message) => {
    const session = document.querySelector<HTMLElement>(
      '.shell-project-workbench:not([hidden])',
    )?.dataset.session;
    window.postMessage({ ...message, session }, '*');
  }, payload);

  const reviewTab = launched.page.locator(
    '.shell-dock-tab[data-kind="review"]',
  );
  await expect(reviewTab).toBeVisible();
  const review = launched.page.locator('.desktop-review-pane');
  await expect(review).toBeVisible();
  await expect(review.locator('.desktop-review-summary strong')).toHaveText(
    'Compare paper.tex',
  );
  await expect(review.locator('.desktop-review-file')).toContainText(
    'paper.tex',
  );
  await expect(review.locator('.desktop-review-counts')).toContainText('+1');
  await expect(review.locator('.desktop-review-counts')).toContainText('-1');
  // Both sides of the change, as the diff editor renders them.
  const diff = review.locator('.monaco-diff-editor');
  await expect(diff).toContainText('old body');
  await expect(diff).toContainText('new body');

  // A close for a diff the pane no longer holds leaves the tab standing.
  await launched.page.evaluate(() => {
    window.postMessage(
      {
        command: 'desktop:closeDiff',
        previewId: 'a-superseded-preview',
        session: document.querySelector<HTMLElement>(
          '.shell-project-workbench:not([hidden])',
        )?.dataset.session,
      },
      '*',
    );
  });
  await expect(
    launched.page.locator('.shell-dock-tab[data-kind="review"]'),
  ).toHaveCount(1);

  // Close via desktop:closeDiff naming the diff it opened — the Review tab
  // should close.
  await launched.page.evaluate(() => {
    window.postMessage(
      {
        command: 'desktop:closeDiff',
        previewId: 'trajectory-review',
        session: document.querySelector<HTMLElement>(
          '.shell-project-workbench:not([hidden])',
        )?.dataset.session,
      },
      '*',
    );
  });
  await expect(
    launched.page.locator('.shell-dock-tab[data-kind="review"]'),
  ).toHaveCount(0);
});

/** The host opens compiled PDFs in the originating paper's workbench. */
test('desktop:showPdf opens and closes an in-app PDF workbench', async () => {
  const { page } = launched;
  const pdfUrl = 'file:///tmp/texra-trajectory/output.pdf';
  const session = await page
    .locator('.shell-project-workbench:not([hidden])')
    .getAttribute('data-session');
  const pdfTab = page.locator('.shell-dock-tab[data-kind="pdf"]');
  const frame = page.locator('iframe.shell-workbench-pdf-frame');

  await page.evaluate(
    ({ session, pdfUrl }) => {
      window.postMessage(
        {
          command: 'desktop:showPdf',
          session,
          title: 'output.pdf',
          pdfUrl,
          build: 1,
        },
        '*',
      );
    },
    { session, pdfUrl },
  );
  await expect(pdfTab).toBeVisible();
  await expect(pdfTab.locator('xpath=..')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(pdfTab).toContainText('output.pdf');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('src', pdfUrl);
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(frame).toHaveAttribute('title', 'output.pdf');

  const rejectedUrl = page.waitForEvent('console', (message) =>
    message.text().includes('Dropped a malformed desktop:showPdf push'),
  );
  await page.evaluate((session) => {
    window.postMessage(
      {
        command: 'desktop:showPdf',
        session,
        title: 'malicious',
        pdfUrl: 'http://evil.com/x.pdf',
        build: 1,
      },
      '*',
    );
  }, session);
  await rejectedUrl;
  await expect(pdfTab).toHaveCount(1);
  await expect(frame).toHaveAttribute('src', pdfUrl);

  // A PDF is a workbench tab, closed from its own tab like any other.
  await pdfTab.locator('.shell-dock-tab-close wa-button').click();
  await expect(pdfTab).toHaveCount(0);
  await expect(frame).toHaveCount(0);
});

test('command palette opens and dismisses', async () => {
  const { page } = launched;
  await showLauncher(launched);
  await page
    .locator('.shell-sidebar-primary .shell-sidebar-action')
    .filter({ hasText: 'Commands' })
    .click();
  const palette = page.locator('.desktop-command-palette');
  await expect(palette).toHaveAttribute('open');
  await expect(palette.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.desktop-command-palette[open]')).toHaveCount(0);
});

// The vertical settings navigation must remain operable by keyboard, and
// its controls must stay reachable when the native window shrinks.
test('settings navigation works by keyboard and stays reachable in a small window', async () => {
  const { page } = launched;
  await setSettingsTab(launched, 'general');
  const settings = page.locator('wa-dialog.desktop-settings-overlay');
  const pages = settings.getByRole('tablist', { name: 'Settings pages' });
  await expect(pages).toHaveAttribute('aria-orientation', 'vertical');
  const tabs = pages.getByRole('tab');
  await expect(tabs.first()).toHaveAccessibleName('General');
  await tabs.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  // Crossing a visual group heading still advances to the next page.
  await page.keyboard.press('ArrowDown');
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  await resizeWindow(launched, 960, 640);
  try {
    await expect(settings.getByRole('tabpanel')).toBeVisible();
    await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
    await expect(
      settings
        .locator('agent-selection-panel')
        .getByRole('textbox', { name: 'Search agents', exact: true }),
    ).toBeVisible();
    await settings.getByRole('tab', { name: 'Plugins', exact: true }).click();
    await settings
      .getByRole('button', { name: 'Goal Mode', exact: true })
      .click();
    // A toggle row keeps its switch beside its label, centred on it.
    const availability = settings.locator(
      'plugin-card .settings-row.is-toggle',
    );
    const label = await box(availability.locator('.settings-row-label'));
    const toggle = await box(
      settings.getByRole('switch', {
        name: 'Available to agents',
        exact: true,
      }),
    );
    expect(toggle.x).toBeGreaterThan(label.x + label.width);
    expect(
      Math.abs(label.y + label.height / 2 - (toggle.y + toggle.height / 2)),
    ).toBeLessThan(2);
  } finally {
    await resizeWindow(launched, 1280, 800);
  }
});

// Last: it reloads the renderer and leaves the theme on "system".
test('appearance settings override the system and remember the choice', async () => {
  const { page } = launched;
  async function expectTheme(theme: 'light' | 'dark') {
    await expect(page.locator('body')).toHaveClass(
      new RegExp(`vscode-${theme}`),
    );
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
  }

  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme('light');
  const lightBackground = await page
    .locator('.shell-frame')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  await chooseDesktopTheme(page, 'dark');
  await expectTheme('dark');
  await expect(page.locator('.shell-frame')).not.toHaveCSS(
    'background-color',
    lightBackground,
  );
  // Selecting the current choice must retain a valid single selection.
  await chooseDesktopTheme(page, 'dark');
  await page.reload();
  await expectTheme('dark');
  const themeControl = await openDesktopAppearance(page);
  await expect(themeControl).toHaveJSProperty('value', 'dark');
  await page.locator('.desktop-settings-close').click();

  await page.emulateMedia({ colorScheme: 'dark' });
  await chooseDesktopTheme(page, 'light');
  await expectTheme('light');
  await expect(page.locator('.shell-frame')).toHaveCSS(
    'background-color',
    lightBackground,
  );
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme('light');
  await chooseDesktopTheme(page, 'system');
  await expectTheme('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme('light');
  await page.emulateMedia({ forcedColors: 'active' });
  await expect(page.locator('body')).toHaveClass(/vscode-high-contrast/);
  await page.emulateMedia({ forcedColors: 'none', colorScheme: 'dark' });
  await expectTheme('dark');
});
