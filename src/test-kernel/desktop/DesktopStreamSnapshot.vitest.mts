// Node imports
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - shared schemas
import { STREAM_PHASE } from '@shared/schemas';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

const writeFileAtomicMock = vi.hoisted(() =>
  vi.fn(async (filePath: string, data: string) => {
    const { writeFile: writeFileImpl } = await import('node:fs/promises');
    await writeFileImpl(filePath, data);
  }),
);

vi.mock('write-file-atomic', () => ({
  default: writeFileAtomicMock,
}));

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
  flush(): Promise<void>;
  getAll(): Snapshot[];
};

interface Module {
  DESKTOP_STREAM_SNAPSHOT_WRITE_DEBOUNCE_MS: number;
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
    lastKnownStatus: STREAM_PHASE.RUNNING,
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
  let debounceMs: number;
  let openDesktopStreamSnapshotStore: Module['openDesktopStreamSnapshotStore'];

  beforeEach(async () => {
    const module = await loadModule();
    debounceMs = module.DESKTOP_STREAM_SNAPSHOT_WRITE_DEBOUNCE_MS;
    openDesktopStreamSnapshotStore = module.openDesktopStreamSnapshotStore;
    writeFileAtomicMock.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (tempDir == null) return;
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  async function tempFilePath(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'texra-stream-snapshot-'));
    return join(tempDir, 'streams.json');
  }

  async function readPersistedSnapshots(filePath: string): Promise<Snapshot[]> {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as {
      restoredStreams: { streams: Snapshot[] };
    };
    return raw.restoredStreams.streams;
  }

  function deferred(): {
    promise: Promise<void>;
    resolve(): void;
  } {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  it('starts empty when the file does not exist', async () => {
    const store = await openDesktopStreamSnapshotStore(await tempFilePath());

    expect(store.hydrated).toEqual([]);
    expect(store.getAll()).toEqual([]);
  });

  it('persists snapshots and reloads them on a fresh open', async () => {
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

  it('preserves RUNNING phase on hydrate for startup repair', async () => {
    const filePath = await tempFilePath();

    const writer = await openDesktopStreamSnapshotStore(filePath);
    await writer.upsert(
      makeSnapshot({ lastKnownStatus: STREAM_PHASE.RUNNING }),
    );

    const reopened = await openDesktopStreamSnapshotStore(filePath);
    expect(reopened.hydrated[0]?.lastKnownStatus).toBe(STREAM_PHASE.RUNNING);
  });

  it('preserves WAITING phase on hydrate for startup repair', async () => {
    const filePath = await tempFilePath();

    const writer = await openDesktopStreamSnapshotStore(filePath);
    await writer.upsert(
      makeSnapshot({ lastKnownStatus: STREAM_PHASE.WAITING }),
    );

    const reopened = await openDesktopStreamSnapshotStore(filePath);
    expect(reopened.hydrated[0]?.lastKnownStatus).toBe(STREAM_PHASE.WAITING);
  });

  it('normalises inactive phases to COMPLETED on hydrate', async () => {
    const filePath = await tempFilePath();

    const writer = await openDesktopStreamSnapshotStore(filePath);
    await writer.upsert(makeSnapshot({ lastKnownStatus: STREAM_PHASE.FAILED }));

    const reopened = await openDesktopStreamSnapshotStore(filePath);
    expect(reopened.hydrated[0]?.lastKnownStatus).toBe(STREAM_PHASE.COMPLETED);
  });

  it('preserves parent stream links on hydrate', async () => {
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
    const filePath = await tempFilePath();

    const store = await openDesktopStreamSnapshotStore(filePath);
    await store.upsert(makeSnapshot({ description: 'first' }));
    await store.upsert(makeSnapshot({ description: 'second' }));

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0]?.description).toBe('second');
  });

  it('coalesces rapid upserts into one debounced write', async () => {
    vi.useFakeTimers();
    const filePath = await tempFilePath();
    const store = await openDesktopStreamSnapshotStore(filePath);

    const first = store.upsert(makeSnapshot({ description: 'first' }));
    const second = store.upsert(
      makeSnapshot({
        streamId: 'toolUseAgent@2',
        agentCategory: 'toolUse',
        description: 'second',
      }),
    );

    await vi.advanceTimersByTimeAsync(debounceMs - 1);
    expect(writeFileAtomicMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);

    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
    expect(await readPersistedSnapshots(filePath)).toEqual([
      expect.objectContaining({
        streamId: 'workflowAgent@1',
        description: 'first',
      }),
      expect.objectContaining({
        streamId: 'toolUseAgent@2',
        description: 'second',
      }),
    ]);
  });

  it('flush persists a pending debounced upsert immediately', async () => {
    vi.useFakeTimers();
    const filePath = await tempFilePath();
    const store = await openDesktopStreamSnapshotStore(filePath);

    const pending = store.upsert(makeSnapshot({ description: 'pending' }));
    await store.flush();
    await pending;

    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
    expect(await readPersistedSnapshots(filePath)).toEqual([
      expect.objectContaining({ description: 'pending' }),
    ]);
  });

  it('flush drains upserts scheduled while a write is in flight', async () => {
    vi.useFakeTimers();
    const filePath = await tempFilePath();
    const store = await openDesktopStreamSnapshotStore(filePath);
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    writeFileAtomicMock.mockImplementationOnce(async (target, data) => {
      firstWriteStarted.resolve();
      await releaseFirstWrite.promise;
      await writeFile(target, data);
    });

    const first = store.upsert(makeSnapshot({ description: 'first' }));
    const flush = store.flush();
    await firstWriteStarted.promise;
    const second = store.upsert(
      makeSnapshot({
        streamId: 'toolUseAgent@2',
        agentCategory: 'toolUse',
        description: 'second',
      }),
    );
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    releaseFirstWrite.resolve();
    await flush;
    await Promise.resolve();

    expect(secondSettled).toBe(true);
    await Promise.all([first, second]);
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(2);
    expect(await readPersistedSnapshots(filePath)).toEqual([
      expect.objectContaining({
        streamId: 'workflowAgent@1',
        description: 'first',
      }),
      expect.objectContaining({
        streamId: 'toolUseAgent@2',
        description: 'second',
      }),
    ]);

    await vi.advanceTimersByTimeAsync(debounceMs);
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(2);
  });

  it('remove drops a snapshot and persists the removal', async () => {
    const filePath = await tempFilePath();

    const store = await openDesktopStreamSnapshotStore(filePath);
    await store.upsert(makeSnapshot());
    await store.remove('workflowAgent@1');

    expect(store.getAll()).toEqual([]);

    const reopened = await openDesktopStreamSnapshotStore(filePath);
    expect(reopened.hydrated).toEqual([]);
  });

  it('remove persists immediately when a debounced upsert is pending', async () => {
    vi.useFakeTimers();
    const filePath = await tempFilePath();
    const store = await openDesktopStreamSnapshotStore(filePath);

    const pending = store.upsert(makeSnapshot());
    await store.remove('workflowAgent@1');
    await pending;

    expect(store.getAll()).toEqual([]);
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
    expect(await readPersistedSnapshots(filePath)).toEqual([]);

    await vi.advanceTimersByTimeAsync(debounceMs);
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
  });

  it('remove is a no-op when the id is unknown', async () => {
    const store = await openDesktopStreamSnapshotStore(await tempFilePath());
    await expect(store.remove('does-not-exist')).resolves.toBeUndefined();
  });

  it('replaceAll wipes the snapshot list', async () => {
    const filePath = await tempFilePath();

    const store = await openDesktopStreamSnapshotStore(filePath);
    await store.upsert(makeSnapshot());
    await store.replaceAll([]);

    const reopened = await openDesktopStreamSnapshotStore(filePath);
    expect(reopened.hydrated).toEqual([]);
  });

  it('replaceAll persists immediately when a debounced upsert is pending', async () => {
    vi.useFakeTimers();
    const filePath = await tempFilePath();
    const store = await openDesktopStreamSnapshotStore(filePath);
    const replacement = makeSnapshot({
      streamId: 'replacement@1',
      description: 'replacement',
    });

    const pending = store.upsert(makeSnapshot({ description: 'pending' }));
    await store.replaceAll([replacement]);
    await pending;

    expect(store.getAll()).toEqual([replacement]);
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
    expect(await readPersistedSnapshots(filePath)).toEqual([replacement]);

    await vi.advanceTimersByTimeAsync(debounceMs);
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid present snapshot value', async () => {
    const filePath = await tempFilePath();
    const invalid = JSON.stringify({
      restoredStreams: { version: 1, streams: 'not-an-array' },
    });
    await writeFile(filePath, invalid);

    await expect(openDesktopStreamSnapshotStore(filePath)).rejects.toThrow();
  });

  it('writes a versioned envelope under the restoredStreams key', async () => {
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
