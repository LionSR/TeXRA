import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect } from '@playwright/test';

import { workspaceStorageId } from '../../src/main/platform/electronStorage.js';
import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';

const SETTINGS_TAB_INDEX = {
  MEMORY: 0,
} as const;

const MEMORY_FILE_NAME = 'playwright-relaunch-memory.md';
const MEMORY_DISPLAY_PATH = `/memories/${MEMORY_FILE_NAME}`;
const MEMORY_PREVIEW_TEXT =
  'This memory entry is created by the desktop multi-launch Playwright fixture.';
const MEMORY_FILE_CONTENT = `${MEMORY_PREVIEW_TEXT}

It verifies that the same workspace storage is read after relaunch.
`;

function writeMemoryEntry(input: {
  userDataPath: string;
  workspacePath: string;
}): void {
  const memoryDir = join(
    input.userDataPath,
    'workspace-storage',
    workspaceStorageId(input.workspacePath),
    'memories',
  );
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, MEMORY_FILE_NAME), MEMORY_FILE_CONTENT, 'utf8');
}

function cleanupDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup. A stale temp dir is preferable to masking the
    // assertion that actually failed.
  }
}

async function setRoute(
  launched: LaunchedApp,
  route: 'main' | 'progress' | 'settings' | 'logs',
): Promise<void> {
  await launched.page.evaluate((next) => {
    window.postMessage({ command: 'desktop:setRoute', route: next }, '*');
  }, route);
  await launched.page.waitForFunction(
    (target) => document.body.dataset.desktopRoute === target,
    route,
    { timeout: 5000 },
  );
}

async function setSettingsTab(
  launched: LaunchedApp,
  tabIndex: number,
): Promise<void> {
  await setRoute(launched, 'settings');
  await launched.page.evaluate((idx) => {
    window.postMessage({ command: 'setTab', tabIndex: idx }, '*');
  }, tabIndex);
  await launched.page.waitForFunction(
    () => {
      const settingsApp = document.querySelector('settings-app');
      return settingsApp?.shadowRoot != null;
    },
    undefined,
    { timeout: 10_000 },
  );
}

async function refreshMemoryData(launched: LaunchedApp): Promise<void> {
  await launched.page.evaluate(() => {
    window.postMessage({ command: 'getMemoryData' }, '*');
  });
}

async function waitForMemoryEntry(launched: LaunchedApp): Promise<void> {
  await launched.page.waitForFunction(
    ({ displayPath, previewText }) => {
      const settingsApp = document.querySelector('settings-app');
      const root = settingsApp?.shadowRoot;
      const memoryTab = root?.querySelector('memory-tab') as
        | (HTMLElement & { shadowRoot: ShadowRoot })
        | null;
      const memoryList = memoryTab?.shadowRoot?.querySelector('memory-list') as
        | (HTMLElement & { shadowRoot: ShadowRoot })
        | null;
      const itemElements = Array.from(
        memoryList?.shadowRoot?.querySelectorAll('memory-item') ?? [],
      ) as Array<
        HTMLElement & {
          item?: { displayPath?: string; preview?: string };
        }
      >;

      return itemElements.some((element) => {
        const item = element.item;
        return (
          item?.displayPath === displayPath &&
          item.preview?.includes(previewText)
        );
      });
    },
    {
      displayPath: MEMORY_DISPLAY_PATH,
      previewText: MEMORY_PREVIEW_TEXT,
    },
    { timeout: 10_000 },
  );

  await expect(launched.page.locator('settings-app')).toHaveCount(1);
}

async function verifyMemoryEntryIsListed(launched: LaunchedApp): Promise<void> {
  await setSettingsTab(launched, SETTINGS_TAB_INDEX.MEMORY);
  await refreshMemoryData(launched);
  await waitForMemoryEntry(launched);
}

test('settings memory entries survive relaunch with shared user data', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'texra-e2e-workspace-'));
  const userDataPath = mkdtempSync(join(tmpdir(), 'texra-e2e-user-data-'));
  let currentLaunch: LaunchedApp | undefined;

  try {
    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    await dismissOnboarding(currentLaunch.page);

    writeMemoryEntry({ userDataPath, workspacePath });
    await verifyMemoryEntryIsListed(currentLaunch);

    await closeTexraApp(currentLaunch);
    currentLaunch = undefined;

    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    await dismissOnboarding(currentLaunch.page);
    await verifyMemoryEntryIsListed(currentLaunch);
  } finally {
    if (currentLaunch) {
      await closeTexraApp(currentLaunch);
    }
    cleanupDirectory(workspacePath);
    cleanupDirectory(userDataPath);
  }
});
