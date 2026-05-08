import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

/**
 * Standalone-trajectory audit suite — companion to
 * `docs/dev/standalone-trajectory-audit.md`.
 *
 * These tests don't replace `screenshots.spec.ts`; they walk through the
 * critical user journeys identified in issue #3643 (auth, workspace open,
 * settings persistence, agent run) and assert the renderer surfaces a sane
 * UI for each. When a step is a known stub or partial integration the test
 * documents the gap with a soft assertion rather than failing — the goal is
 * a regression guard for the trajectory itself, not the full feature.
 */

// SETTINGS_TAB indices (mirror of `src/shared/schemas/settingsViewMessages.ts`
// `SETTINGS_TAB_ORDER`). Inlined for the same reason as in screenshots.spec.ts:
// the Playwright ESM loader trips over the schema import.
const SETTINGS_TAB_INDEX = {
  MEMORY: 0,
  HISTORY: 1,
  MODELS: 2,
  AGENTS: 3,
  MULTI_AGENT: 4,
  TOOLS: 5,
  GIT: 6,
  LATEX: 7,
} as const;

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchTexraApp();
  // Dismiss the first-run walkthrough so it doesn't intercept clicks.
  await launched.page.waitForFunction(
    () => {
      const btn = Array.from(document.querySelectorAll('wa-button')).find(
        (b) => b.textContent?.trim() === 'Got it',
      );
      return btn instanceof HTMLElement;
    },
    undefined,
    { timeout: 10_000 },
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

async function setRoute(
  route: 'main' | 'progress' | 'settings' | 'logs',
): Promise<void> {
  await launched.page.evaluate((next) => {
    window.postMessage({ command: 'desktop:setRoute', route: next }, '*');
  }, route);
  await launched.page.waitForFunction(
    (target) => {
      const section = document.querySelector<HTMLElement>(
        `.desktop-route[data-route="${target}"]`,
      );
      return section != null && section.hidden === false;
    },
    route,
    { timeout: 5000 },
  );
}

async function setSettingsTab(tabIndex: number): Promise<void> {
  await setRoute('settings');
  await launched.page.evaluate((idx) => {
    window.postMessage({ command: 'setTab', tabIndex: idx }, '*');
  }, tabIndex);
  // Best-effort: wait for the settings-app shadow DOM to mount.
  await launched.page.waitForFunction(
    () => {
      const settingsSection = document.querySelector(
        '.desktop-route[data-route="settings"]',
      );
      const settingsApp = settingsSection?.querySelector('settings-app');
      return settingsApp?.shadowRoot != null;
    },
    undefined,
    { timeout: 10_000 },
  );
}

/**
 * Trajectory 1 — first launch on an empty workspace.
 * The launcher (main route) must mount without crashing the renderer.
 */
test('first launch shows a usable launcher chrome', async () => {
  await setRoute('main');
  // The chrome brand and Open Folder button must be reachable from the user.
  // The brand label is styled uppercase via CSS, but the underlying text
  // node is "TeXRA". Match case-insensitively so a future style flip won't
  // destabilise the test.
  const brand = await launched.page
    .locator('.desktop-brand')
    .first()
    .innerText();
  expect(brand.toLowerCase()).toContain('texra');
  const folderButton = launched.page.locator('.desktop-folder-button');
  await expect(folderButton).toBeVisible();
  // The main view itself either renders <main-app> or the no-workspace empty
  // state — both are valid first-launch outcomes. The audit doc tracks which
  // one each user actually hits.
  const mainSection = launched.page.locator('.desktop-route[data-route="main"]');
  await expect(mainSection).toBeVisible();
});

/**
 * Trajectory 2 — Settings: Models tab carries the auth banner + provider grid.
 *
 * In the standalone Electron build the Researcher Access (auth) banner is
 * rendered inside the Models settings tab (not the launcher). The walkthrough
 * dismissal above means we land on the launcher, then jump to settings.
 */
test('settings → models tab mounts and the auth surface is reachable', async () => {
  await setSettingsTab(SETTINGS_TAB_INDEX.MODELS);
  // Confirm the Models panel actually activated; without this we may catch
  // the previous tab's render and report a false positive.
  await launched.page.waitForFunction(
    () => {
      const settingsApp = document.querySelector(
        '.desktop-route[data-route="settings"] settings-app',
      );
      const root = settingsApp?.shadowRoot;
      const activePanel = root?.querySelector(
        'wa-tab-panel[name="models"][active]',
      );
      const activeTab = root?.querySelector('wa-tab[panel="models"][active]');
      return activeTab != null || activePanel != null;
    },
    undefined,
    { timeout: 10_000 },
  );
  // Sanity: the panel mounted a child custom element (the profile/models
  // surface). The actual auth banner text and provider list live one or
  // two shadow roots deep, so we only assert structural presence here.
  const panelHasChild = await launched.page.evaluate(() => {
    const settingsApp = document.querySelector(
      '.desktop-route[data-route="settings"] settings-app',
    );
    const panel = settingsApp?.shadowRoot?.querySelector(
      'wa-tab-panel[name="models"][active]',
    );
    return panel != null && panel.children.length > 0;
  });
  expect(panelHasChild).toBe(true);
});

/**
 * Trajectory 3 — Memory tab is the leftmost settings panel; restart-survival
 * cannot be tested from a single Playwright run (the harness recreates a
 * temp workspace per launch), but we can at least verify the tab mounts.
 *
 * Follow-up: the audit doc lists "memory survives relaunch" as a manual
 * QA scenario. Adding a multi-launch Playwright fixture is tracked there.
 */
test('settings → memory tab mounts', async () => {
  await setSettingsTab(SETTINGS_TAB_INDEX.MEMORY);
  await launched.page.waitForFunction(
    () => {
      const settingsApp = document.querySelector(
        '.desktop-route[data-route="settings"] settings-app',
      );
      const root = settingsApp?.shadowRoot;
      const activePanel = root?.querySelector(
        'wa-tab-panel[name="memory"][active]',
      );
      const activeTab = root?.querySelector('wa-tab[panel="memory"][active]');
      return activeTab != null || activePanel != null;
    },
    undefined,
    { timeout: 10_000 },
  );
});

/**
 * Trajectory 4 — Logs view: ensure the Logs route renders the desktop log
 * viewer skeleton (header + actions). The actual log content is async and
 * may be empty on a fresh run, so we only assert structural surfaces.
 */
test('logs route renders the desktop log viewer', async () => {
  await setRoute('logs');
  const header = launched.page.locator('.desktop-log-viewer-header');
  await expect(header).toBeVisible();
  // Header has Refresh / Copy / Export / Open Folder buttons.
  const actions = launched.page.locator('.desktop-log-viewer-actions wa-button');
  await expect(actions).toHaveCount(4);
});

/**
 * Trajectory 5 — Tools settings: confirms the tab mounts so the user can
 * see the install/check tool surface. The actual install flow is captured
 * as a partial-integration finding in the audit doc (Electron currently
 * surfaces a copy-the-command dialog rather than running it for the user).
 */
test('settings → tools tab mounts', async () => {
  await setSettingsTab(SETTINGS_TAB_INDEX.TOOLS);
  await launched.page.waitForFunction(
    () => {
      const settingsApp = document.querySelector(
        '.desktop-route[data-route="settings"] settings-app',
      );
      const root = settingsApp?.shadowRoot;
      const activePanel = root?.querySelector(
        'wa-tab-panel[name="tools"][active]',
      );
      const activeTab = root?.querySelector('wa-tab[panel="tools"][active]');
      return activeTab != null || activePanel != null;
    },
    undefined,
    { timeout: 10_000 },
  );
});

/**
 * Trajectory 6 — settings persistence smoke. Without a multi-launch fixture
 * we cannot fully prove restart-survival, but we can drive the tab a few
 * times and confirm the inner panels do not crash. Failures here would be
 * the kind of "renderer threw mid-tab-switch" regression that breaks the
 * standalone story; covering it cheaply is worth the few hundred ms.
 */
test('rapid settings-tab switching does not crash the renderer', async () => {
  for (const idx of [
    SETTINGS_TAB_INDEX.MEMORY,
    SETTINGS_TAB_INDEX.MODELS,
    SETTINGS_TAB_INDEX.AGENTS,
    SETTINGS_TAB_INDEX.MULTI_AGENT,
    SETTINGS_TAB_INDEX.LATEX,
  ]) {
    await setSettingsTab(idx);
  }
  // The chrome must still be alive after the burst.
  await expect(launched.page.locator('.desktop-brand')).toBeVisible();
});

/**
 * Trajectory 18 — in-app diff overlay (audit item C).
 *
 * `desktopDiffHost` posts `desktop:showDiff` to the renderer; the renderer
 * lazy-creates a wa-dialog overlay containing `<texra-diff-view>`. We
 * simulate the IPC by `window.postMessage`-ing the same payload and assert
 * the dialog opens and carries the supplied title + content.
 *
 * Monaco is heavy (workers + WASM) so we don't wait for the editor to
 * finish loading — only that the dialog and the `<texra-diff-view>`
 * element exist with the right props.
 */
test('desktop:showDiff opens the in-app diff overlay', async () => {
  // Reset chrome to a known state — the previous test may have left
  // settings open.
  await launched.page.evaluate(() => {
    const dialogs = document.querySelectorAll('wa-dialog');
    dialogs.forEach((d) => {
      (d as unknown as { open: boolean }).open = false;
    });
  });

  const payload = {
    command: 'desktop:showDiff',
    title: 'Compare paper.tex',
    originalText: '\\documentclass{article}\nold body\n',
    proposedText: '\\documentclass{article}\nnew body\n',
    language: 'latex',
    originalPath: '/tmp/original/paper.tex',
    proposedPath: '/tmp/proposed/paper.tex',
  };

  await launched.page.evaluate((message) => {
    window.postMessage(message, '*');
  }, payload);

  // Wait for the dialog to appear and open. wa-dialog reflects `open` as
  // an attribute when set; check both since timing of wa internals
  // varies.
  await launched.page.waitForFunction(
    () => {
      const dialog = document.querySelector('wa-dialog.desktop-diff-overlay');
      if (!dialog) return false;
      const open = (dialog as unknown as { open: boolean }).open === true;
      return open || dialog.hasAttribute('open');
    },
    undefined,
    { timeout: 5000 },
  );

  const dialog = launched.page.locator('wa-dialog.desktop-diff-overlay');
  await expect(dialog).toHaveCount(1);
  // Title + subtitle are populated from the payload.
  await expect(dialog.locator('.desktop-diff-title')).toHaveText(
    'Compare paper.tex',
  );
  await expect(dialog.locator('.desktop-diff-subtitle')).toHaveText(
    '/tmp/proposed/paper.tex',
  );
  // The diff component element exists with the right props (we don't
  // wait for Monaco to finish loading — verifying the contract is enough).
  const diffViewProps = await launched.page.evaluate(() => {
    const el = document.querySelector(
      'wa-dialog.desktop-diff-overlay texra-diff-view',
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

  // Close via desktop:closeDiff — the dialog should close.
  await launched.page.evaluate(() => {
    window.postMessage({ command: 'desktop:closeDiff' }, '*');
  });
  await launched.page.waitForFunction(
    () => {
      const dialog = document.querySelector('wa-dialog.desktop-diff-overlay');
      if (!dialog) return true;
      return (dialog as unknown as { open: boolean }).open === false;
    },
    undefined,
    { timeout: 5000 },
  );
});
