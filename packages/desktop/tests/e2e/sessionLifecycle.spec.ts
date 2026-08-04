import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  closeTexraApp,
  launchTexraApp,
  type LaunchedApp,
} from './electronApp.js';
import {
  cleanupDirectory,
  createIsolatedProfile,
  findWorkspaceStoragePath,
} from './workspaceStorageFixture.js';

const WAITING_STREAM = 'e2e-waiting#a11ce1';
const WAITING_EXECUTION = 'a11ce1';
const ORPHAN_STREAM = 'e2e-orphan#baddad';
const ORPHAN_EXECUTION = 'baddad';

interface PersistedLogEntry {
  id?: unknown;
  type?: unknown;
  data?: { status?: unknown };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeCanonicalStreamFixture(input: {
  storagePath: string;
  streamId: string;
  executionId: string;
  resumable: boolean;
  timestamp: number;
}): void {
  const encodedStream = encodeURIComponent(input.streamId);
  const transcriptDirectory = join(input.storagePath, 'streamLogs');
  const sidecarDirectory = join(input.storagePath, 'streamData', encodedStream);
  const executionDirectory = join(
    input.storagePath,
    'executions',
    input.executionId,
  );
  mkdirSync(transcriptDirectory, { recursive: true });
  mkdirSync(sidecarDirectory, { recursive: true });
  mkdirSync(executionDirectory, { recursive: true });

  writeJson(join(transcriptDirectory, `${encodedStream}.json`), [
    {
      seqNo: 1,
      id: `${input.streamId}-running-group`,
      type: 'group-start',
      level: 'info',
      timestamp: input.timestamp,
      data: { status: 'running' },
    },
  ]);
  writeJson(join(sidecarDirectory, 'meta.json'), {
    schemaVersion: 1,
    executionId: input.executionId,
  });
  writeJson(join(executionDirectory, 'config.json'), {
    agent: 'search',
    model: 'deepseekproT',
    agentCategory: 'toolUse',
  });
  writeJson(join(executionDirectory, 'meta.json'), {
    schemaVersion: 1,
    timestamp: new Date(input.timestamp).toISOString(),
    streamId: input.streamId,
  });

  if (input.resumable) {
    writeJson(join(executionDirectory, `flow_${input.executionId}.json`), {
      schemaVersion: 2,
      flowName: 'texra',
      shared: { messages: [] },
      createdAt: new Date(input.timestamp).toISOString(),
      cursor: { nextNodeId: 'start' },
      nodes: [],
    });
  }
}

function readTranscript(
  storagePath: string,
  streamId: string,
): PersistedLogEntry[] {
  const path = join(
    storagePath,
    'streamLogs',
    `${encodeURIComponent(streamId)}.json`,
  );
  return JSON.parse(readFileSync(path, 'utf8')) as PersistedLogEntry[];
}

function terminalGroupStatus(storagePath: string, streamId: string): unknown {
  return readTranscript(storagePath, streamId).find(
    (entry) => entry.id === `${streamId}-running-group`,
  )?.data?.status;
}

async function processId(launched: LaunchedApp): Promise<number> {
  return launched.app.evaluate(() => process.pid);
}

test('macOS window close detaches and activation reopens in the same process', async () => {
  test.skip(
    process.platform !== 'darwin',
    'macOS keeps the process windowless',
  );

  const launched = await launchTexraApp();
  const initialPage = launched.page;
  const initialPid = await processId(launched);

  try {
    const browserWindow = await launched.app.browserWindow(initialPage);
    await browserWindow.evaluate((window) => window.close());
    await expect.poll(() => launched.app.windows().length).toBe(0);

    const reopenedPagePromise = launched.app.waitForEvent('window');
    await launched.app.evaluate(({ app }) => app.emit('activate'));
    const reopenedPage = await reopenedPagePromise;
    await reopenedPage.waitForSelector('#app', { state: 'attached' });

    expect(reopenedPage).not.toBe(initialPage);
    expect(await processId(launched)).toBe(initialPid);
  } finally {
    await closeTexraApp(launched);
  }
});

test('a new desktop process repairs canonical waiting and orphaned streams', async () => {
  const { workspacePath, userDataPath } = createIsolatedProfile();
  let currentLaunch: LaunchedApp | undefined;

  try {
    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    const firstPid = await processId(currentLaunch);
    await closeTexraApp(currentLaunch);
    currentLaunch = undefined;

    const storagePath = findWorkspaceStoragePath({
      userDataPath,
      workspacePath,
    });
    writeCanonicalStreamFixture({
      storagePath,
      streamId: WAITING_STREAM,
      executionId: WAITING_EXECUTION,
      resumable: true,
      timestamp: 1_750_000_000_000,
    });
    writeCanonicalStreamFixture({
      storagePath,
      streamId: ORPHAN_STREAM,
      executionId: ORPHAN_EXECUTION,
      resumable: false,
      timestamp: 1_750_000_001_000,
    });

    currentLaunch = await launchTexraApp({ workspacePath, userDataPath });
    expect(await processId(currentLaunch)).not.toBe(firstPid);

    await expect
      .poll(() => terminalGroupStatus(storagePath, WAITING_STREAM))
      .toBe('cancelled');
    await expect
      .poll(() => terminalGroupStatus(storagePath, ORPHAN_STREAM))
      .toBe('failed');

    await expect
      .poll(async () =>
        currentLaunch!.page.locator('stream-tab').evaluateAll((tabs) =>
          tabs.map((tab) => ({
            streamId: (tab as HTMLElement & { info?: { name?: string } }).info
              ?.name,
            status: (tab as HTMLElement & { status?: string }).status,
          })),
        ),
      )
      .toEqual(
        expect.arrayContaining([
          { streamId: WAITING_STREAM, status: 'waiting' },
          { streamId: ORPHAN_STREAM, status: 'failed' },
        ]),
      );
  } finally {
    if (currentLaunch) await closeTexraApp(currentLaunch);
    cleanupDirectory(workspacePath);
    cleanupDirectory(userDataPath);
  }
});
