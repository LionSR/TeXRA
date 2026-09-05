import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  openWorkbench,
  showLauncher,
  setSettingsTab,
  type LaunchedApp,
} from './electronApp.js';

/**
 * Standalone-trajectory audit suite — companion to
 * `docs/dev/audits/2026-05-08-standalone-trajectory-audit.md`.
 *
 * These tests don't replace `screenshots.spec.ts`; they walk through the
 * critical user journeys identified in issue #3643 (auth, workspace open,
 * settings persistence, agent run) and assert the renderer surfaces a sane
 * UI for each. When a step is a known stub or partial integration the test
 * documents the gap with a soft assertion rather than failing — the goal is
 * a regression guard for the trajectory itself, not the full feature.
 */

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchTexraApp();
  // Dismiss the first-run walkthrough so it doesn't intercept clicks.
  await dismissOnboarding(launched.page);
});

test.afterAll(async () => {
  if (launched) await closeTexraApp(launched);
});

/**
 * Trajectory 1 — first launch on an empty workspace.
 * The launcher must mount without crashing the renderer.
 */
test('first launch shows a usable launcher chrome', async () => {
  await showLauncher(launched);
  // The workspace directory and command palette button must be reachable.
  const workspaceDirectory =
    launched.workspacePath.split(/[\\/]/).at(-1) ?? launched.workspacePath;
  const directoryLabel = await launched.page
    .locator('.task-project-copy strong')
    .first()
    .innerText();
  expect(directoryLabel).toContain(workspaceDirectory);
  await expect(
    launched.page.locator('.task-header-button[aria-label="Show Commands"]'),
  ).toBeVisible();
  // The main view itself either renders <main-app> or the no-workspace empty
  // state — both are valid first-launch outcomes. The audit doc tracks which
  // one each user actually hits.
  const mainSection = launched.page.locator(
    '.task-conversation-pane[data-pane="launcher"]',
  );
  await expect(mainSection).toBeVisible();
});

/**
 * Trajectory 2 — Settings: Models tab carries model access + provider keys.
 *
 * Account identity and usage live in their own page; Models remains the single
 * home for configuring model access and provider credentials.
 */
test('settings → models tab mounts and provider settings are reachable', async () => {
  // Confirm the Models panel actually activated; without this we may catch
  // the previous tab's render and report a false positive.
  await setSettingsTab(launched, 'models');
  // Sanity: the panel mounted its child custom element. The provider list lives
  // another shadow root deep, so structural presence is sufficient here.
  const panelHasChild = await launched.page.evaluate(() => {
    const settingsApp = document.querySelector('settings-app');
    return settingsApp?.shadowRoot?.querySelector('models-tab') != null;
  });
  expect(panelHasChild).toBe(true);
});

test('account and usage lives in its own settings panel', async () => {
  await setSettingsTab(launched, 'account');

  const structure = await launched.page.evaluate(() => {
    const root = document.querySelector('settings-app')?.shadowRoot;
    const account = root?.querySelector('account-tab');
    return {
      accountPage: account?.shadowRoot?.querySelector('.account-page') != null,
      persistentHeader: root?.querySelector('.settings-header') != null,
    };
  });

  expect(structure).toEqual({
    accountPage: true,
    persistentHeader: false,
  });
});

/**
 * Trajectory 3 — Memory tab is the leftmost settings panel. Cross-launch
 * persistence is covered by `settingsPersistence.spec.ts`, which relaunches
 * the desktop app on a shared Electron user-data directory.
 */
test('settings → memory tab mounts', async () => {
  await setSettingsTab(launched, 'memory');
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
          text: '2026-07-26T12:00:00.000Z [info] Geometry check',
          truncated: false,
        },
      },
      '*',
    );
  });
  const infoSurface = launched.page.locator(
    '.desktop-log-entry[data-level="info"] .desktop-log-entry-level-icon',
  );
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
});

/**
 * Trajectory 5 — Tools settings: confirms the tab mounts so the user can
 * see the install/check tool surface. The actual install flow is captured
 * as a partial-integration finding in the audit doc (Electron currently
 * surfaces a copy-the-command dialog rather than running it for the user).
 */
test('settings → tools tab mounts', async () => {
  await setSettingsTab(launched, 'tools');
});

/**
 * Trajectory 6 — settings tab switching smoke. Drive the tab a few times and
 * confirm the inner panels do not crash. Failures here would be the kind of
 * "renderer threw mid-tab-switch" regression that breaks the standalone story;
 * covering it cheaply is worth the few hundred ms.
 */
test('rapid settings-tab switching does not crash the renderer', async () => {
  for (const tab of [
    'memory',
    'models',
    'agents',
    'multi-agent',
    'latex',
  ] as const) {
    await setSettingsTab(launched, tab);
  }
  // The chrome must still be alive after the burst.
  await expect(
    launched.page.locator('.task-project-copy strong'),
  ).toBeVisible();
  await expect(launched.page.locator('.task-conversation')).toBeVisible();
});

/**
 * Trajectory 18 — in-app Review workbench.
 *
 * `desktopDiffHost` posts `desktop:showDiff` to the renderer; the renderer
 * opens a persistent Review tab containing `<texra-diff-view>` and a changed
 * file tree. We simulate the IPC by `window.postMessage`-ing the same payload
 * and assert the workbench opens and carries the supplied title + content.
 *
 * Monaco is heavy (workers + WASM) so we don't wait for the editor to
 * finish loading — only that the workbench and the `<texra-diff-view>`
 * element exist with the right props.
 */
test('desktop:showDiff opens the in-app Review workbench', async () => {
  const payload = {
    command: 'desktop:showDiff',
    title: 'Compare paper.tex',
    displayPath: 'paper.tex',
    originalText: '\\documentclass{article}\nold body\n',
    proposedText: '\\documentclass{article}\nnew body\n',
    additions: 1,
    deletions: 1,
    language: 'latex',
  };

  await launched.page.evaluate((message) => {
    window.postMessage(message, '*');
  }, payload);

  const reviewTab = launched.page.locator(
    '.task-workbench-tab[data-kind="review"][data-active="true"]',
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
  // The diff component element exists with the right props (we don't
  // wait for Monaco to finish loading — verifying the contract is enough).
  const diffViewProps = await launched.page.evaluate(() => {
    const el = document.querySelector(
      '.desktop-review-pane texra-diff-view',
    ) as
      | (HTMLElement & {
          originalText: string;
          proposedText: string;
          language: string;
        })
      | null;
    if (!el) return null;
    return {
      originalText: el.originalText,
      proposedText: el.proposedText,
      language: el.language,
    };
  });
  expect(diffViewProps).not.toBeNull();
  expect(diffViewProps?.originalText).toContain('old body');
  expect(diffViewProps?.proposedText).toContain('new body');
  expect(diffViewProps?.language).toBe('latex');

  // Close via desktop:closeDiff — the Review tab should close.
  await launched.page.evaluate(() => {
    window.postMessage({ command: 'desktop:closeDiff' }, '*');
  });
  await expect(
    launched.page.locator('.task-workbench-tab[data-kind="review"]'),
  ).toHaveCount(0);
});
