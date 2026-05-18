import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { test, expect } from '@playwright/test';

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

// Mirror of `workspaceStorageId` from
// `src/platform/defaults/workspaceStorage.ts`. Inlined because Playwright's
// ESM loader cannot safely import root TypeScript modules through `.js`
// specifiers during test discovery.
function workspaceStorageId(workspacePath: string | undefined): string {
  const source = workspacePath?.trim() || 'no-workspace';
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 8);
  const stem =
    source === 'no-workspace'
      ? 'no-workspace'
      : basename(source)
          .replaceAll(/[^A-Za-z0-9._-]/g, '-')
          .replaceAll(/-+/g, '-')
          .replaceAll(/^-|-$/g, '') || 'workspace';
  return `${stem}-${hash}`;
}

function writeMemoryEntry(input: {
  userDataPath: string;
  workspacePath: string;
}): void {
  const workspaceId = workspaceStorageId(resolve(input.workspacePath));
  const memoryDir = join(
    input.userDataPath,
    'workspace-storage',
    workspaceId,
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
  await sendHostCommand(launched, { command: 'getMemoryData' });
}

async function sendHostCommand(
  launched: LaunchedApp,
  message: Record<string, unknown>,
): Promise<void> {
  await launched.page.evaluate((payload) => {
    // Backend commands must use the host bridge; `window.postMessage` only
    // reaches renderer-side listeners.
    const bridge = (
      window as Window & {
        __texraHostBridgeApi?: {
          postMessage(message: unknown): void;
        };
      }
    ).__texraHostBridgeApi;
    if (!bridge) {
      throw new Error('TeXRA host bridge is not available');
    }
    bridge.postMessage(payload);
  }, message);
}

interface RenderedMemoryItem {
  displayPath?: string;
  storagePath?: string;
  preview?: string;
}

async function readRenderedMemoryItems(
  launched: LaunchedApp,
): Promise<RenderedMemoryItem[]> {
  return launched.page
    .locator('settings-app memory-tab memory-list memory-item')
    .evaluateAll((elements) =>
      elements.map(
        (element) =>
          (element as HTMLElement & { item?: RenderedMemoryItem }).item ?? {},
      ),
    );
}

async function waitForRenderedMemoryItem(
  launched: LaunchedApp,
  predicate: (item: RenderedMemoryItem) => boolean,
): Promise<void> {
  await expect
    .poll(
      async () => (await readRenderedMemoryItems(launched)).some(predicate),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function waitForMemoryEntry(launched: LaunchedApp): Promise<void> {
  await waitForRenderedMemoryItem(
    launched,
    (item) => item.displayPath === MEMORY_DISPLAY_PATH,
  );

  const item = (await readRenderedMemoryItems(launched)).find(
    (candidate) => candidate.displayPath === MEMORY_DISPLAY_PATH,
  );
  if (item?.storagePath) {
    await sendHostCommand(launched, {
      command: 'getMemoryPreview',
      storagePath: item.storagePath,
    });
  }

  await waitForRenderedMemoryItem(
    launched,
    (candidate) =>
      candidate.displayPath === MEMORY_DISPLAY_PATH &&
      candidate.preview?.includes(MEMORY_PREVIEW_TEXT) === true,
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
