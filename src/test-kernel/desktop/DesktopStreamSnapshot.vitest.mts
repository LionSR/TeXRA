// Node imports
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - shared schemas
import { STREAM_STATUS } from '@shared/schemas';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

type Snapshot = {
  streamId: string;
  label: string;
  agent?: string;
  agentCategory: 'workflow' | 'toolUse';
  inputFile?: string;
  instruction?: string;
  lastKnownStatus: string;
  description?: string;
  executionId?: string;
  parentStreamId?: string;
  creationTimestamp: number;
  lastTimestamp?: number;
  persistedAt: number;
};

type Store = {
  hydrated: readonly Snapshot[];
  upsert(snapshot: Snapshot): Promise<void>;
  remove(id: string): Promise<void>;
  replaceAll(snapshots: Snapshot[]): Promise<void>;
  getAll(): Snapshot[];
};

interface Module {
  openDesktopStreamSnapshotStore(
    filePath: string,
    options?: { log?: { warn(...args: unknown[]): void } },
  ): Promise<Store>;
}

async function loadModule(): Promise<Module> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopStreamSnapshot.ts'))
  ) as Promise<Module>;
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    streamId: 'workflowAgent@1',
    label: 'workflowAgent: paper.tex',
    agent: 'workflowAgent',
    agentCategory: 'workflow',
    inputFile: 'paper.tex',
    instruction: 'Polish the abstract',
    lastKnownStatus: STREAM_STATUS.RUNNING,
    description: 'Polish the abstract section',
    executionId: 'abc-123',
    creationTimestamp: 1_700_000_000_000,
    lastTimestamp: 1_700_000_500_000,
    persistedAt: 1_700_000_500_500,
    ...overrides,
  };
}

describe('DesktopStreamSnapshot', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir == null) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  async function tempFilePath(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-stream-snapshot-'));
    return join(tempDir, 'streams.json');
  }

  it('starts empty when the file does not exist', async () => {
    const { openDesktopStreamSnapshotStore } = await loadModule();
    const store = await openDesktopStreamSnapshotStore(await tempFilePath());

    expect(store.hydrated).toEqual([]);
    expect(store.getAll()).toEqual([]);
  });

  it('persists snapshots and reloads them on a fresh open', async () => {
    const { openDesktopStreamSnapshotStore } = await loadModule();
    const filePath = await tempFilePath();

    const initial = await openDesktopStreamSnapshotStore(filePath);
    await initial.upsert(makeSnapshot());
    await initial.upsert(
      makeSnapshot({ streamId: 'toolUseAgent@2', agentCategory: 'toolUse' }),
    );

    const reopened = await openDesktopStreamSnapshotStore(filePath);
    expect(reopened.hydrated).toHaveLength(2);
    const ids = reopened.hydrated.map((s) => s.streamId).sort();
    expect(ids).toEqual(['toolUseAgent@2', 'workflowAgent@1']);
  });

  it('normalises status to STOPPED on hydrate', async () => {
    const { openDesktopStreamSnapshotStore } = await loadModule();
    const filePath = await tempFilePath();

    const writer = await openDesktopStreamSnapshotStore(filePath);
    await writer.upsert(
      makeSnapshot({ lastKnownStatus: STREAM_STATUS.RUNNING }),
    );

    const reopened = await openDesktopStreamSnapshotStore(filePath);
    expect(
      reopened.hydrated.every((s) => s.lastKnownStatus === 'stopped'),
    ).toBe(true);
  });

  it('preserves parent stream links on hydrate', async () => {
    const { openDesktopStreamSnapshotStore } = await loadModule();
    const filePath = await tempFilePath();

    const writer = await openDesktopStreamSnapshotStore(filePath);
    await writer.upsert(
      makeSnapshot({
        streamId: 'child@2',
        parentStreamId: 'parent@1',
      }),
    );

    const reopened = await openDesktopStreamSnapshotStore(filePath);
    expect(reopened.hydrated[0]?.parentStreamId).toBe('parent@1');
  });

  it('upsert overwrites an existing snapshot with the same id', async () => {
    const { openDesktopStreamSnapshotStore } = await loadModule();
    const filePath = await tempFilePath();

    const store = await openDesktopStreamSnapshotStore(filePath);
    await store.upsert(makeSnapshot({ description: 'first' }));
    await store.upsert(makeSnapshot({ description: 'second' }));

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0]?.description).toBe('second');
  });

  it('remove drops a snapshot and persists the removal', async () => {
    const { openDesktopStreamSnapshotStore } = await loadModule();
    const filePath = await tempFilePath();

    const store = await openDesktopStreamSnapshotStore(filePath);
    await store.upsert(makeSnapshot());
    await store.remove('workflowAgent@1');

    expect(store.getAll()).toEqual([]);

    const reopened = await openDesktopStreamSnapshotStore(filePath);
    expect(reopened.hydrated).toEqual([]);
  });

  it('remove is a no-op when the id is unknown', async () => {
    const { openDesktopStreamSnapshotStore } = await loadModule();
    const store = await openDesktopStreamSnapshotStore(await tempFilePath());
    await expect(store.remove('does-not-exist')).resolves.toBeUndefined();
  });

  it('replaceAll wipes the snapshot list', async () => {
    const { openDesktopStreamSnapshotStore } = await loadModule();
    const filePath = await tempFilePath();

    const store = await openDesktopStreamSnapshotStore(filePath);
    await store.upsert(makeSnapshot());
    await store.replaceAll([]);

    const reopened = await openDesktopStreamSnapshotStore(filePath);
    expect(reopened.hydrated).toEqual([]);
  });

  it('discards a malformed snapshot file without throwing', async () => {
    const { openDesktopStreamSnapshotStore } = await loadModule();
    tempDir = await mkdtemp(join(tmpdir(), 'texra-stream-snapshot-'));
    const filePath = join(tempDir, 'streams.json');
    await writeFile(filePath, '{ not json');

    const warn = (..._args: unknown[]): void => {};
    const store = await openDesktopStreamSnapshotStore(filePath, {
      log: { warn },
    });
    expect(store.hydrated).toEqual([]);
  });

  it('writes a versioned envelope under the restoredStreams key', async () => {
    const { openDesktopStreamSnapshotStore } = await loadModule();
    const filePath = await tempFilePath();

    const store = await openDesktopStreamSnapshotStore(filePath);
    await store.upsert(makeSnapshot());

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      restoredStreams: { version: number; streams: Snapshot[] };
    };
    expect(raw.restoredStreams.version).toBe(1);
    expect(raw.restoredStreams.streams).toHaveLength(1);
  });
});
