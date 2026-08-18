import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect } from '@playwright/test';

import {
  closeTexraApp,
  dismissOnboarding,
  launchTexraApp,
  setSettingsTab,
  type LaunchedApp,
} from './electronApp.js';
import {
  cleanupDirectory,
  createIsolatedProfile,
  findWorkspaceStoragePath,
} from './workspaceStorageFixture.js';

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
  const memoryDir = join(findWorkspaceStoragePath(input), 'memories');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, MEMORY_FILE_NAME), MEMORY_FILE_CONTENT, 'utf8');
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

function isTargetMemory(item: RenderedMemoryItem): boolean {
  return item.displayPath === MEMORY_DISPLAY_PATH;
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
  await waitForRenderedMemoryItem(launched, isTargetMemory);

  const item = (await readRenderedMemoryItems(launched)).find(isTargetMemory);
  if (item?.storagePath) {
    await sendHostCommand(launched, {
      command: 'getMemoryPreview',
      storagePath: item.storagePath,
    });
  }

  await waitForRenderedMemoryItem(
    launched,
    (candidate) =>
      isTargetMemory(candidate) &&
      candidate.preview?.includes(MEMORY_PREVIEW_TEXT) === true,
  );

  await expect(launched.page.locator('settings-app')).toHaveCount(1);
}

async function verifyMemoryEntryIsListed(launched: LaunchedApp): Promise<void> {
  await setSettingsTab(launched, 'memory');
  await sendHostCommand(launched, { command: 'getMemoryData' });
  await waitForMemoryEntry(launched);
}

test('settings memory entries survive relaunch with shared user data', async () => {
  const { workspacePath, userDataPath } = createIsolatedProfile();
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
