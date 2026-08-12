// Node imports
import * as path from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import * as logUtils from '@logger/logUtils';
import { FileType, type FileStat } from '@platform/interfaces';
import {
  END_GROUP_STATUS,
  LOG_LEVELS,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type StreamLogEntry,
} from '@shared/schemas';
import { createDeferred, waitForCondition } from '@test/support/asyncTestUtils';
import { appendTranscriptEntry } from '@test/support/storeTestDrivers';
import {
  ephemeralTranscriptWarning,
  StreamLogStore,
  STREAM_LOGS_DIR,
  STREAM_LOG_SUMMARIES_DIR,
  type StreamLogAppendInput,
} from '@transcript';
import { delay } from '@utils/core';
import { StorageFS } from '@utils/files/storageFS';

interface MockStorageOptions {
  /** Values are usually arrays; non-array values simulate corrupt logs. */
  logs: Record<string, unknown>;
  summaries: Record<string, unknown>;
  rawLogJson?: Record<string, string>;
  rawSummaryJson?: Record<string, string>;
  logReadError?: Error;
  summaryEnsureDirError?: Error;
  summaryWriteError?: Error;
  summaryDeleteError?: Error;
  logWriteError?: Error;
  logDeleteError?: Error;
  logMtimes?: Record<string, number>;
  summaryMtimes?: Record<string, number>;
  onLogRead?: (key: string) => Promise<void> | void;
  onLogWrite?: (key: string) => Promise<void> | void;
  onSummaryWrite?: (key: string) => Promise<void> | void;
  pauseLogWriteKey?: string;
}

function storageFile(dir: string, key: string): string {
  return path.join(dir, `${encodeURIComponent(key)}.json`);
}

/** Which of the two stream-log directories a mocked target file lives in. */
function areaOf(target: string): 'log' | 'summary' | null {
  if (target.startsWith(`${STREAM_LOG_SUMMARIES_DIR}${path.sep}`)) {
    return 'summary';
  }
  if (target.startsWith(`${STREAM_LOGS_DIR}${path.sep}`)) return 'log';
  return null;
}

function writtenLog(
  writes: ReadonlyMap<string, unknown>,
  streamId: string,
): StreamLogEntry[] {
  return writes.get(storageFile(STREAM_LOGS_DIR, streamId)) as StreamLogEntry[];
}

function streamKeyFromFile(target: string): string {
  return decodeURIComponent(path.basename(target).replace(/\.json$/, ''));
}

function notFound(): NodeJS.ErrnoException {
  const error = new Error('not found') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function namedEntry(
  id: string,
  timestamp: number,
  text: string,
): StreamLogAppendInput {
  return {
    id,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp,
    messageType: MESSAGE_TYPES.DEFAULT,
    text,
  };
}

function logEntry(
  streamId: string,
  seqNo: number,
  timestamp: number,
): StreamLogEntry {
  return {
    ...namedEntry(
      `${streamId}-${seqNo}`,
      timestamp,
      `${streamId} entry ${seqNo}`,
    ),
    seqNo,
  };
}

function summary(
  firstTimestamp: number,
  lastTimestamp: number,
  rest: Record<string, boolean> = {},
): Record<string, unknown> {
  return { firstTimestamp, lastTimestamp, ...rest };
}

/** The summary a settled stream writes back after every orphan is closed. */
function settledSummary(
  firstTimestamp: number,
  lastTimestamp: number,
): Record<string, unknown> {
  return summary(firstTimestamp, lastTimestamp, {
    hasRunningGroup: false,
    hasRunningStreamingText: false,
  });
}

function writtenSummary(
  writes: ReadonlyMap<string, unknown>,
  streamId: string,
): unknown {
  return writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, streamId));
}

function runningGroupEntry(
  streamId: string,
  seqNo: number,
  timestamp: number,
): StreamLogEntry {
  return {
    seqNo,
    id: `${streamId}-group-${seqNo}`,
    type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
    level: LOG_LEVELS.INFO,
    timestamp,
    data: { status: 'running' },
  };
}

/** A thinking/scratchpad/model-response entry whose stream never finalized. */
function runningStreamingTextEntry(
  streamId: string,
  seqNo: number,
  timestamp: number,
): StreamLogEntry {
  return {
    seqNo,
    id: `${streamId}-thinking-${seqNo}`,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp,
    messageType: MESSAGE_TYPES.THINKING,
    text: 'reasoning in progress',
    data: { status: 'running' },
  };
}

function runningWorkflowCallEntry(
  streamId: string,
  seqNo: number,
  timestamp: number,
  status: 'planned' | 'running' = 'running',
): StreamLogEntry {
  const label = status === 'planned' ? 'Audit extension' : 'Audit core';
  return {
    seqNo,
    id: `${streamId}-workflow-task-${seqNo}`,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp,
    messageType: MESSAGE_TYPES.WORKFLOW_TASK,
    text: label,
    data: {
      id: status === 'planned' ? 'audit-extension' : 'audit-core',
      label,
      phase: 'Audit',
      status,
    },
  };
}

function fileStat(mtime: number): FileStat {
  return {
    type: FileType.File,
    ctime: mtime,
    mtime,
    size: 1,
  };
}

function mockStorage({
  logs,
  summaries,
  rawLogJson = {},
  rawSummaryJson = {},
  logReadError,
  summaryEnsureDirError,
  summaryWriteError,
  summaryDeleteError,
  logWriteError,
  logDeleteError,
  logMtimes = {},
  summaryMtimes = {},
  onLogRead,
  onLogWrite,
  onSummaryWrite,
  pauseLogWriteKey,
}: MockStorageOptions): {
  deletes: string[];
  ensuredDirs: string[];
  fullLogReads: () => number;
  releasePausedWrite: () => void;
  waitForPausedWrite: () => Promise<void>;
  writes: Map<string, unknown>;
} {
  let fullLogReads = 0;
  let pausedLogWriteUsed = false;
  const pausedWriteStarted = createDeferred();
  const pausedWriteRelease = createDeferred();
  const deletes: string[] = [];
  const ensuredDirs: string[] = [];
  const writes = new Map<string, unknown>();

  vi.spyOn(StorageFS, 'readDir').mockImplementation(async (target) => {
    if (target !== STREAM_LOGS_DIR) throw notFound();
    return Object.keys(logs).map((key) => [
      `${encodeURIComponent(key)}.json`,
      FileType.File,
    ]);
  });

  // KVStore reads raw strings through StorageFS, so hand back JSON
  // text for its deserializer to parse.
  vi.spyOn(StorageFS, 'read').mockImplementation(async (target) => {
    const key = streamKeyFromFile(target);

    if (areaOf(target) === 'summary') {
      if (!Object.hasOwn(summaries, key)) throw notFound();
      return rawSummaryJson[key] ?? JSON.stringify(summaries[key]);
    }

    if (areaOf(target) === 'log') {
      if (!Object.hasOwn(logs, key)) throw notFound();
      fullLogReads += 1;
      if (logReadError) throw logReadError;
      await onLogRead?.(key);
      return rawLogJson[key] ?? JSON.stringify(logs[key]);
    }

    throw new Error(`Unexpected read target: ${target}`);
  });

  vi.spyOn(StorageFS, 'ensureDir').mockImplementation(async (target) => {
    ensuredDirs.push(target);
    if (target === STREAM_LOG_SUMMARIES_DIR && summaryEnsureDirError) {
      throw summaryEnsureDirError;
    }
  });
  vi.spyOn(StorageFS, 'exists').mockImplementation(async (target) => {
    const key = streamKeyFromFile(target);
    if (areaOf(target) === 'summary') return Object.hasOwn(summaries, key);
    if (areaOf(target) === 'log') return Object.hasOwn(logs, key);
    throw new Error(`Unexpected exists target: ${target}`);
  });
  vi.spyOn(StorageFS, 'stat').mockImplementation(async (target) => {
    const key = streamKeyFromFile(target);
    if (areaOf(target) === 'summary') {
      if (!Object.hasOwn(summaries, key)) throw notFound();
      return fileStat(summaryMtimes[key] ?? 2);
    }
    if (areaOf(target) === 'log') {
      if (!Object.hasOwn(logs, key)) throw notFound();
      return fileStat(logMtimes[key] ?? 1);
    }
    throw new Error(`Unexpected stat target: ${target}`);
  });
  const recordWrite = async (
    target: string,
    content: string | Uint8Array,
  ): Promise<void> => {
    if (logWriteError && areaOf(target) === 'log') throw logWriteError;
    if (summaryWriteError && areaOf(target) === 'summary') {
      throw summaryWriteError;
    }
    if (
      pauseLogWriteKey != null &&
      !pausedLogWriteUsed &&
      target === storageFile(STREAM_LOGS_DIR, pauseLogWriteKey)
    ) {
      pausedLogWriteUsed = true;
      pausedWriteStarted.resolve();
      await pausedWriteRelease.promise;
    }
    if (areaOf(target) === 'log') {
      await onLogWrite?.(streamKeyFromFile(target));
    }
    if (areaOf(target) === 'summary') {
      await onSummaryWrite?.(streamKeyFromFile(target));
    }

    const text =
      typeof content === 'string'
        ? content
        : Buffer.from(content).toString('utf8');
    writes.set(target, JSON.parse(text));
  };
  vi.spyOn(StorageFS, 'write').mockImplementation(recordWrite);
  vi.spyOn(StorageFS, 'writeAtomic').mockImplementation(recordWrite);
  vi.spyOn(StorageFS, 'delete').mockImplementation(async (target) => {
    if (logDeleteError && areaOf(target) === 'log') throw logDeleteError;
    if (
      summaryDeleteError &&
      (target === STREAM_LOG_SUMMARIES_DIR || areaOf(target) === 'summary')
    ) {
      throw summaryDeleteError;
    }
    deletes.push(target);
    writes.delete(target);
  });

  return {
    deletes,
    ensuredDirs,
    fullLogReads: () => fullLogReads,
    releasePausedWrite: () => pausedWriteRelease.resolve(),
    waitForPausedWrite: () =>
      pauseLogWriteKey == null ? Promise.resolve() : pausedWriteStarted.promise,
    writes,
  };
}

type MockStorage = ReturnType<typeof mockStorage>;

/**
 * Flushes while the paused write is in flight, then deletes mid-flush: the
 * delete must win over the pending write.
 */
async function flushAcrossDelete(
  store: StreamLogStore,
  storage: MockStorage,
  streamId: string,
): Promise<void> {
  const flush = store.flush();
  await storage.waitForPausedWrite();
  const deletion = store.delete(streamId);
  storage.releasePausedWrite();
  await Promise.all([flush, deletion]);
}

describe('StreamLogStore load', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a valid persistent store before exposing it', async () => {
    mockStorage({ logs: {}, summaries: {} });

    const store = await StreamLogStore.open();

    expect(store.mode).toEqual({ kind: 'persistent' });
    expect(Object.isFrozen(store.mode)).toBe(true);
    expect(store.keys()).toEqual([]);
  });

  it('persists an empty stream registration across fresh opens', async () => {
    const logs: Record<string, unknown> = {};
    const storage = mockStorage({ logs, summaries: {} });

    const first = await StreamLogStore.open();
    first.ensureStream('registered-empty');
    await first.flush();

    expect(writtenLog(storage.writes, 'registered-empty')).toEqual([]);
    logs['registered-empty'] = [];

    const second = await StreamLogStore.open();
    expect(second.keys()).toEqual(['registered-empty']);
    expect(second.get('registered-empty')).toBeUndefined();

    const third = await StreamLogStore.open();
    expect(third.keys()).toEqual(['registered-empty']);
    expect(storage.fullLogReads()).toBe(2);
  });

  it('distinguishes another process deletion from a stale local summary', async () => {
    const logs: Record<string, unknown> = { alpha: [] };
    mockStorage({ logs, summaries: {} });

    const staleProcessStore = await StreamLogStore.open();
    expect(staleProcessStore.has('alpha')).toBe(true);
    await expect(
      staleProcessStore.hasAuthoritativeStream('alpha'),
    ).resolves.toBe(true);

    // A different process commits deletion while this store retains the
    // summary it loaded at startup.
    delete logs.alpha;

    expect(staleProcessStore.has('alpha')).toBe(true);
    await expect(
      staleProcessStore.hasAuthoritativeStream('alpha'),
    ).resolves.toBe(false);
  });

  it('opens a read-only store without creating directories or writing caches', async () => {
    const storage = mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {},
    });

    const store = await StreamLogStore.openReadOnlyForStream('alpha');

    expect(store.mode).toEqual({ kind: 'read-only' });
    expect(storage.ensuredDirs).toEqual([]);
    expect(storage.fullLogReads()).toBe(1);
    expect(storage.writes.size).toBe(0);
    expect(store.keys()).toEqual(['alpha']);
    await store.ensureLoaded('alpha');
    expect(store.get('alpha')?.size).toBe(1);
    expect(() =>
      appendTranscriptEntry(store, 'alpha', logEntry('alpha', 2, 250)),
    ).toThrow('read-only transcript store');
    expect(() => store.ensureStream('beta')).toThrow(
      'read-only transcript store',
    );
  });

  it('constructs an inspectable ephemeral store only with an explicit reason', async () => {
    const store = StreamLogStore.ephemeral('interactive fallback test');

    store.ensureStream('empty-ephemeral');
    appendTranscriptEntry(
      store,
      'ephemeral-stream',
      logEntry('ephemeral-stream', 1, 100),
    );
    store.requestEviction('ephemeral-stream');
    await store.flush();

    expect(store.mode).toEqual({
      kind: 'ephemeral',
      reason: 'interactive fallback test',
    });
    expect(store.has('empty-ephemeral')).toBe(true);
    expect(store.get('empty-ephemeral')?.size).toBe(0);
    expect(store.get('ephemeral-stream')?.size).toBe(1);
    expect(() => StreamLogStore.ephemeral('  ')).toThrow('requires a reason');
  });

  it('defers a requested eviction until the exact writer releases', async () => {
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: {},
    });
    const store = await StreamLogStore.open();
    await store.ensureLoaded('alpha');
    const writer = store.acquireWriter('alpha', 'execution-alpha');

    store.requestEviction('alpha');
    writer.append(logEntry('alpha-live', 2, 200));
    await store.flush();

    expect(store.get('alpha')?.size).toBe(2);
    writer.close();
    expect(store.get('alpha')).toBeUndefined();
    expect(() => writer.append(logEntry('late', 3, 300))).toThrow(
      'has been released',
    );
  });

  it('reserves a writer across rehydration and a concurrent eviction', async () => {
    const readStarted = createDeferred();
    const readGate = createDeferred();
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: false }),
      },
      onLogRead: async () => {
        readStarted.resolve();
        await readGate.promise;
      },
    });
    const store = await StreamLogStore.open();
    const writerPromise = store.loadAndAcquireWriter(
      'alpha',
      'execution-alpha',
    );
    await readStarted.promise;

    store.requestEviction('alpha');
    readGate.resolve();
    const writer = await writerPromise;

    expect(store.get('alpha')?.size).toBe(1);
    expect(() => writer.append(logEntry('alpha-live', 2, 200))).not.toThrow();
    writer.close();
    await store.flush();
    expect(store.get('alpha')).toBeUndefined();
  });

  it('keeps a requested eviction resident until its sequential write finishes', async () => {
    const storage = mockStorage({
      logs: {},
      summaries: {},
      pauseLogWriteKey: 'alpha',
    });
    const store = await StreamLogStore.open();
    const alphaWriter = store.acquireWriter('alpha', 'execution-alpha');
    const betaWriter = store.acquireWriter('beta', 'execution-beta');
    alphaWriter.append(logEntry('alpha', 1, 100));
    betaWriter.append(logEntry('beta', 1, 200));

    const flush = store.flush();
    await storage.waitForPausedWrite();
    store.requestEviction('beta');
    betaWriter.close();

    // Both dirty bits were moved into the active write batch. The explicit
    // flushing guard must keep beta resident while the sequential writer is
    // still blocked on alpha.
    expect(store.get('beta')?.size).toBe(1);

    storage.releasePausedWrite();
    await flush;
    expect(writtenLog(storage.writes, 'beta')).toHaveLength(1);
    expect(store.get('beta')).toBeUndefined();
    alphaWriter.close();
  });

  it('keeps a same-owner successor valid after an older writer closes', () => {
    const store = StreamLogStore.ephemeral('writer identity test');
    const first = store.acquireWriter('alpha', 'execution-alpha');
    const successor = store.acquireWriter('alpha', 'execution-alpha');

    expect(() => store.acquireWriter('alpha', 'execution-beta')).toThrow(
      'already owned by another writer',
    );
    first.close();
    expect(() => first.append(logEntry('late', 1, 100))).toThrow(
      'has been released',
    );
    expect(() => successor.append(logEntry('successor', 2, 200))).not.toThrow();
    successor.close();
  });

  it('preserves queued eviction across a same-owner successor', async () => {
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: {},
    });
    const store = await StreamLogStore.open();
    await store.ensureLoaded('alpha');
    const first = store.acquireWriter('alpha', 'execution-alpha');

    store.requestEviction('alpha');
    const successor = store.acquireWriter('alpha', 'execution-alpha');
    first.close();
    successor.append(logEntry('alpha-live', 2, 200));
    await store.flush();
    successor.close();

    expect(store.get('alpha')).toBeUndefined();
  });

  it('rejects when persistent storage cannot be opened', async () => {
    vi.spyOn(StorageFS, 'ensureDir').mockRejectedValue(
      new Error('storage permission denied'),
    );

    await expect(StreamLogStore.open()).rejects.toThrow(
      'storage permission denied',
    );
  });

  it('degrades to an ephemeral store instead of failing an interactive host startup', async () => {
    vi.spyOn(StorageFS, 'ensureDir').mockRejectedValue(
      new Error('storage permission denied'),
    );
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});

    const { mode } = await StreamLogStore.openOrEphemeral();

    expect(mode).toEqual({
      kind: 'ephemeral',
      reason: 'Persistent transcript opening failed: storage permission denied',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamLogStore',
      'Persistent transcript opening failed: storage permission denied',
    );
    if (mode.kind !== 'ephemeral') throw new Error('expected ephemeral mode');
    // The warning an interactive host shows is the one that tells the user
    // this session cannot be resumed.
    expect(ephemeralTranscriptWarning(mode.reason)).toContain(
      'cannot be resumed',
    );
  });

  it('rejects when an authoritative transcript log cannot be read', async () => {
    const failure = new Error('authoritative transcript read denied');
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {},
      logReadError: failure,
    });

    await expect(StreamLogStore.open()).rejects.toBe(failure);
  });

  it('opens from authoritative logs when the summary directory cannot be prepared', async () => {
    const storage = mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {},
      summaryEnsureDirError: new Error('summary directory is read-only'),
    });
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});

    const store = await StreamLogStore.open();

    expect(store.keys()).toEqual(['alpha']);
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(storage.fullLogReads()).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamLogStore',
      expect.stringContaining('Failed to prepare transcript summary cache'),
    );
  });

  it('opens from authoritative logs when summary cache writeback fails', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 200)],
        beta: [logEntry('beta', 1, 300)],
      },
      summaries: {},
      summaryWriteError: new Error('summary write denied'),
    });
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});

    const store = await StreamLogStore.open();

    expect(store.keys()).toEqual(['alpha', 'beta']);
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(storage.fullLogReads()).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamLogStore',
      expect.stringContaining('Failed to write transcript summary cache for'),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('deletes authoritative logs when summary cache deletion fails', async () => {
    const storage = mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {
        alpha: { firstTimestamp: 200, lastTimestamp: 200 },
      },
      summaryDeleteError: new Error('summary delete denied'),
    });
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const store = await StreamLogStore.open();

    await expect(store.delete('alpha')).resolves.toBeUndefined();

    expect(storage.deletes).toContain(storageFile(STREAM_LOGS_DIR, 'alpha'));
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamLogStore',
      expect.stringContaining(
        'Failed to delete transcript summary cache for alpha',
      ),
    );
  });

  it('retains the stream registry when authoritative log deletion fails', async () => {
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {
        alpha: { firstTimestamp: 200, lastTimestamp: 200 },
      },
      logDeleteError: new Error('log delete denied'),
    });
    const store = await StreamLogStore.open();

    await expect(store.delete('alpha')).rejects.toThrow('log delete denied');

    expect(store.keys()).toEqual(['alpha']);
    expect(store.has('alpha')).toBe(true);
  });

  it('clears authoritative logs when summary cache clearing fails', async () => {
    const storage = mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {
        alpha: { firstTimestamp: 200, lastTimestamp: 200 },
      },
      summaryDeleteError: new Error('summary clear denied'),
    });
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const store = await StreamLogStore.open();

    await expect(store.clear()).resolves.toBeUndefined();

    expect(storage.deletes).toContain(STREAM_LOGS_DIR);
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamLogStore',
      expect.stringContaining('Failed to clear transcript summary cache'),
    );
  });

  it('preserves live state when a transactional reload fails', async () => {
    const logs: Record<string, unknown> = {
      alpha: [logEntry('alpha', 1, 100)],
    };
    mockStorage({
      logs,
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: false }),
      },
    });
    const store = await StreamLogStore.open();
    await store.ensureLoaded('alpha');
    const liveAlpha = store.get('alpha');
    logs.beta = { corrupted: true };

    await expect(store.reload()).rejects.toThrow(
      'persisted log is not an array',
    );

    expect(store.keys()).toEqual(['alpha']);
    expect(store.get('alpha')).toBe(liveAlpha);
    expect(
      store
        .get('alpha')
        ?.getRange(0)
        .map((entry) => entry.id),
    ).toEqual(['alpha-1']);
    expect(store.getFirstTimestamp('alpha')).toBe(100);
    expect(store.has('beta')).toBe(false);
  });

  it('discards pending writes when restoring a previously flushed root', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 100)],
      },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: false }),
      },
    });
    const store = await StreamLogStore.open();
    appendTranscriptEntry(
      store,
      'new-root-dirty',
      logEntry('new-root-dirty', 1, 200),
    );

    await store.reload({ discardPendingWrites: true });

    expect(store.keys()).toEqual(['alpha']);
    expect(
      [...storage.writes.keys()].some((target) =>
        target.includes(encodeURIComponent('new-root-dirty')),
      ),
    ).toBe(false);
  });

  it('prepares transcript directories again after a storage-root reload', async () => {
    const storage = mockStorage({ logs: {}, summaries: {} });
    const store = await StreamLogStore.open();
    appendTranscriptEntry(store, 'old-root', logEntry('old-root', 1, 100));
    await store.flush();
    const oldRootPreparations = storage.ensuredDirs.filter(
      (dir) => dir === STREAM_LOGS_DIR,
    ).length;

    await store.reload();
    appendTranscriptEntry(store, 'new-root', logEntry('new-root', 1, 200));
    await store.flush();

    expect(
      storage.ensuredDirs.filter((dir) => dir === STREAM_LOGS_DIR),
    ).toHaveLength(oldRootPreparations + 1);
  });

  it('uses stream summaries without reading full log files at startup', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 200), logEntry('alpha', 2, 250)],
        beta: [logEntry('beta', 1, 100), logEntry('beta', 2, 160)],
      },
      summaries: {
        alpha: summary(200, 250, { hasRunningGroup: false }),
        beta: summary(100, 160, { hasRunningGroup: false }),
      },
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(0);
    expect(store.keys()).toEqual(['beta', 'alpha']);
    expect(store.get('alpha')).toBeUndefined();
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(store.getLastTimestamp('alpha')).toBe(250);

    await store.ensureLoaded('alpha');

    expect(storage.fullLogReads()).toBe(1);
    expect(store.get('alpha')?.size).toBe(2);
  });

  it('rebuilds from the authoritative log when a summary field has the wrong type', async () => {
    // `hasRunningGroup: 'bad'` is exactly the case a per-field `.catch()`
    // would silently coerce to `undefined` (not running) instead of failing
    // the whole parse — masking a crash-recovery flag that should have
    // triggered the orphan-recovery sweep. The summary schema has no
    // per-field `.catch()`, so a malformed field invalidates the whole
    // cached summary and falls back to the log, like malformed JSON does.
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 200), logEntry('alpha', 2, 250)],
      },
      summaries: {
        alpha: {
          firstTimestamp: 200,
          lastTimestamp: 'bad',
          hasRunningGroup: 'bad',
        },
      },
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(1);
    expect(store.keys()).toEqual(['alpha']);
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(store.getLastTimestamp('alpha')).toBe(250);
    expect(writtenSummary(storage.writes, 'alpha')).toEqual(
      settledSummary(200, 250),
    );
  });

  it('rebuilds malformed summary JSON from the authoritative stream log', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 200), logEntry('alpha', 2, 250)],
      },
      summaries: { alpha: {} },
      rawSummaryJson: { alpha: '{"firstTimestamp":' },
    });
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(1);
    expect(store.keys()).toEqual(['alpha']);
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(store.getLastTimestamp('alpha')).toBe(250);
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamLogStore',
      expect.stringContaining('Ignoring corrupt summary cache for alpha'),
    );
    expect(writtenSummary(storage.writes, 'alpha')).toEqual(
      settledSummary(200, 250),
    );
  });

  it('falls back once for missing summaries and writes the sidecar cache', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 200), logEntry('alpha', 2, 250)],
      },
      summaries: {},
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(1);
    expect(store.keys()).toEqual(['alpha']);
    expect(store.get('alpha')).toBeUndefined();
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(writtenSummary(storage.writes, 'alpha')).toEqual(
      settledSummary(200, 250),
    );
  });

  it('rebuilds stale summaries before trusting them', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 200), logEntry('alpha', 2, 250)],
      },
      summaries: {
        alpha: summary(1, 1, { hasRunningGroup: false }),
      },
      logMtimes: { alpha: 20 },
      summaryMtimes: { alpha: 10 },
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(1);
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(writtenSummary(storage.writes, 'alpha')).toEqual(
      settledSummary(200, 250),
    );
  });

  it('does not register an orphaned summary once its log file is gone', async () => {
    // openReadOnlyForStream trusts the caller's streamId instead of
    // discovering it via a directory listing, so it must independently guard
    // against a summary left behind after its log was deleted.
    const storage = mockStorage({
      logs: {},
      summaries: {
        alpha: summary(100, 150),
      },
    });

    const store = await StreamLogStore.openReadOnlyForStream('alpha');

    expect(storage.fullLogReads()).toBe(0);
    expect(store.has('alpha')).toBe(false);
    expect(store.keys()).toEqual([]);
  });

  it('rehydrates summarized streams with stale running groups', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [runningGroupEntry('alpha', 1, 100)],
      },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: true }),
      },
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(0);

    const affected = await store.endRunningGroupsForStreams(['alpha'], 300);
    await store.flush();
    expect(store.get('alpha')).toBeUndefined();
    expect(storage.fullLogReads()).toBe(1);
    const entry = writtenLog(storage.writes, 'alpha').at(0);

    expect(affected).toEqual(['alpha']);
    expect(entry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    // endRunningGroupsForStreams() defaults to RUN_OUTCOME.FAILED, the orphan
    // sweep's caller-classified default.
    expect(entry?.data).toEqual({ status: RUN_OUTCOME.FAILED, endTime: 300 });
    expect(writtenSummary(storage.writes, 'alpha')).toEqual(
      settledSummary(100, 100),
    );
  });

  it('reports unfinished streams from summaries without loading transcripts', async () => {
    const storage = mockStorage({
      logs: {
        group: [runningGroupEntry('group', 1, 100)],
        streaming: [runningStreamingTextEntry('streaming', 1, 110)],
        complete: [logEntry('complete', 1, 120)],
      },
      summaries: {
        group: summary(100, 100, {
          hasRunningGroup: true,
          hasRunningStreamingText: false,
        }),
        streaming: summary(110, 110, {
          hasRunningGroup: false,
          hasRunningStreamingText: true,
        }),
        complete: summary(120, 120, {
          hasRunningGroup: false,
          hasRunningStreamingText: false,
        }),
      },
    });

    const store = await StreamLogStore.open();

    expect(store.getUnfinishedStreamIds()).toEqual(['group', 'streaming']);
    expect(storage.fullLogReads()).toBe(0);
  });

  it('can close running groups for only selected summarized streams', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [runningGroupEntry('alpha', 1, 100)],
        beta: [runningGroupEntry('beta', 1, 110)],
      },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: true }),
        beta: summary(110, 110, { hasRunningGroup: true }),
      },
    });

    const store = await StreamLogStore.open();

    const affected = await store.endRunningGroupsForStreams(['alpha'], 300);
    await store.flush();

    expect(affected).toEqual(['alpha']);
    expect(storage.fullLogReads()).toBe(1);
    expect(store.get('alpha')).toBeUndefined();
    const entry = writtenLog(storage.writes, 'alpha').at(0);
    expect(entry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(store.get('beta')).toBeUndefined();
    expect(writtenSummary(storage.writes, 'alpha')).toEqual(
      settledSummary(100, 100),
    );
    expect(writtenSummary(storage.writes, 'beta')).toBeUndefined();
  });

  it('keeps already-resident streams after repairing their running groups', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [runningGroupEntry('alpha', 1, 100)],
      },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: true }),
      },
    });
    const store = await StreamLogStore.open();
    await store.ensureLoaded('alpha');

    const affected = await store.endRunningGroupsForStreams(['alpha'], 300);
    await store.flush();

    expect(affected).toEqual(['alpha']);
    expect(storage.fullLogReads()).toBe(1);
    expect(store.get('alpha')?.getRange(0).at(0)?.type).toBe(
      STREAM_LOG_ENTRY_TYPES.GROUP_END,
    );
  });

  it('finalizes an orphaned streaming-text entry even when its group already closed (#7276)', async () => {
    // The task group closed normally (hasRunningGroup: false), but a nested
    // thinking stream never got its stream.end — e.g. an error path that
    // ended the group without also finalizing the in-flight nested stream.
    const storage = mockStorage({
      logs: {
        gamma: [runningStreamingTextEntry('gamma', 1, 100)],
      },
      summaries: {
        gamma: summary(100, 100, {
          hasRunningGroup: false,
          hasRunningStreamingText: true,
        }),
      },
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(0);

    const affected = await store.endRunningGroupsForStreams(['gamma'], 300);
    await store.flush();
    expect(store.get('gamma')).toBeUndefined();
    expect(storage.fullLogReads()).toBe(1);
    const entry = writtenLog(storage.writes, 'gamma').at(0);

    expect(affected).toEqual(['gamma']);
    expect(entry?.data).toEqual({ status: 'completed' });
    expect(writtenSummary(storage.writes, 'gamma')).toEqual(
      settledSummary(100, 100),
    );
  });

  it('settles every orphaned nonterminal workflow call during cold recovery', async () => {
    const storage = mockStorage({
      logs: {
        workflow: [
          runningWorkflowCallEntry('workflow', 1, 100),
          runningWorkflowCallEntry('workflow', 2, 101, 'planned'),
        ],
      },
      summaries: {
        workflow: summary(100, 101, { hasNonterminalWorkflowCall: true }),
      },
    });
    const store = await StreamLogStore.open();

    expect(store.getUnfinishedStreamIds()).toEqual(['workflow']);
    const affected = await store.endRunningGroupsForStreams(['workflow'], 300);
    await store.flush();
    expect(store.get('workflow')).toBeUndefined();
    const entries = writtenLog(storage.writes, 'workflow');

    expect(affected).toEqual(['workflow']);
    expect(entries.at(0)).toMatchObject({
      level: LOG_LEVELS.ERROR,
      settlementSeqNo: 3,
      data: {
        id: 'audit-core',
        status: 'failed',
        error: 'The previous host stopped before this call completed.',
      },
    });
    expect(entries.at(1)).toMatchObject({
      level: LOG_LEVELS.INFO,
      settlementSeqNo: 4,
      data: {
        id: 'audit-extension',
        status: 'skipped',
        reason: 'not-reached',
      },
    });
    expect(writtenSummary(storage.writes, 'workflow')).toEqual(
      settledSummary(100, 101),
    );
  });

  it('can close selected running groups with a caller-supplied RunOutcome', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [runningGroupEntry('alpha', 1, 100)],
      },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: true }),
      },
    });

    const store = await StreamLogStore.open();

    // A caller-supplied RunOutcome (e.g. restart repair's graceful-interrupt
    // classification) reaches the row directly, with no fold to the legacy
    // two-value EndGroupStatus.
    const affected = await store.endRunningGroupsForStreams(
      ['alpha'],
      300,
      RUN_OUTCOME.CANCELLED,
    );
    await store.flush();

    expect(affected).toEqual(['alpha']);
    expect(store.get('alpha')).toBeUndefined();
    expect(storage.fullLogReads()).toBe(1);
    const entry = writtenLog(storage.writes, 'alpha').at(0);
    expect(entry?.data).toEqual({
      status: RUN_OUTCOME.CANCELLED,
      endTime: 300,
    });
  });

  // The one app-side read boundary for legacy GROUP_START/GROUP_END
  // `data.status` wire values left on disk by a pre-cutover writer. Live
  // producers write canonical StreamPhase/RunOutcome values directly, so this
  // path only backfills rows persisted before the cutover.
  it('normalizes legacy persisted GROUP_END status at the read boundary', async () => {
    const legacyStoppedEntry: StreamLogEntry = {
      seqNo: 1,
      id: 'delta-legacy-stopped',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      data: { status: END_GROUP_STATUS.STOPPED, endTime: 150 },
    };
    const legacyErrorEntry: StreamLogEntry = {
      seqNo: 2,
      id: 'delta-legacy-error',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      level: LOG_LEVELS.INFO,
      timestamp: 200,
      data: { status: END_GROUP_STATUS.ERROR, endTime: 250 },
    };
    const legacyRunningStartEntry: StreamLogEntry = {
      seqNo: 3,
      id: 'delta-legacy-running',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 300,
      data: { status: 'running' },
    };
    mockStorage({
      logs: {
        delta: [legacyStoppedEntry, legacyErrorEntry, legacyRunningStartEntry],
      },
      summaries: {},
    });

    const store = await StreamLogStore.open();
    await store.ensureLoaded('delta');

    const entries = store.get('delta')?.getRange(0) ?? [];

    // 'stopped' -> RunOutcome.COMPLETED: a documented lossy default. The
    // pre-cutover 2-value fold already could not distinguish completed from
    // cancelled, and COMPLETED matches today's neutral "Stopped" rendering.
    expect(entries.find((e) => e.id === 'delta-legacy-stopped')?.data).toEqual({
      status: RUN_OUTCOME.COMPLETED,
      endTime: 150,
    });
    // 'error' -> RunOutcome.FAILED: lossless 1:1.
    expect(entries.find((e) => e.id === 'delta-legacy-error')?.data).toEqual({
      status: RUN_OUTCOME.FAILED,
      endTime: 250,
    });
    // 'running' is string-identical to StreamPhase.RUNNING, so it passes
    // through unnormalized.
    expect(entries.find((e) => e.id === 'delta-legacy-running')?.data).toEqual({
      status: STREAM_PHASE.RUNNING,
    });
  });

  it('does not load selected streams whose summaries have no running group', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 100)],
        beta: [runningGroupEntry('beta', 1, 110)],
      },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: false }),
        beta: summary(110, 110, { hasRunningGroup: true }),
      },
    });

    const store = await StreamLogStore.open();

    const affected = await store.endRunningGroupsForStreams(
      ['alpha', 'beta'],
      300,
    );
    await store.flush();

    expect(affected).toEqual(['beta']);
    expect(storage.fullLogReads()).toBe(1);
    expect(store.get('alpha')).toBeUndefined();

    expect(store.get('beta')).toBeUndefined();
    const entry = writtenLog(storage.writes, 'beta').at(0);
    expect(entry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
  });

  it('bounds stale running group rehydrates', async () => {
    const streamIds = Array.from(
      { length: 20 },
      (_, index) => `stream-${index}`,
    );
    const readGate = createDeferred();
    let activeReads = 0;
    let maxActiveReads = 0;

    const storage = mockStorage({
      logs: Object.fromEntries(
        streamIds.map((streamId, index) => [
          streamId,
          [runningGroupEntry(streamId, 1, 100 + index)],
        ]),
      ),
      summaries: Object.fromEntries(
        streamIds.map((streamId, index) => [
          streamId,
          {
            firstTimestamp: 100 + index,
            lastTimestamp: 100 + index,
            hasRunningGroup: true,
          },
        ]),
      ),
      onLogRead: async () => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await readGate.promise;
        activeReads -= 1;
      },
    });

    const store = await StreamLogStore.open();

    const endRunningGroups = store.endRunningGroupsForStreams(streamIds, 300);
    await waitForCondition(() => storage.fullLogReads() === 8, {
      timeoutMessage:
        'Expected stale stream rehydrate reads to reach the concurrency cap',
    });

    expect(maxActiveReads).toBe(8);

    readGate.resolve();
    const affected = await endRunningGroups;
    await store.flush();

    expect(affected).toHaveLength(streamIds.length);
    expect(maxActiveReads).toBe(8);
    expect(storage.fullLogReads()).toBe(streamIds.length);
  });

  it('lets delete win over an in-flight stream write', async () => {
    const storage = mockStorage({
      logs: {},
      summaries: {},
      pauseLogWriteKey: 'delete-me',
    });
    const store = await StreamLogStore.open();

    appendTranscriptEntry(
      store,
      'delete-me',
      namedEntry('delete-me-entry', 500, 'soon deleted'),
    );

    await flushAcrossDelete(store, storage, 'delete-me');

    expect(storage.writes.has(storageFile(STREAM_LOGS_DIR, 'delete-me'))).toBe(
      false,
    );
    expect(
      storage.writes.has(storageFile(STREAM_LOG_SUMMARIES_DIR, 'delete-me')),
    ).toBe(false);
    expect(storage.deletes).toContain(
      storageFile(STREAM_LOGS_DIR, 'delete-me'),
    );
    expect(storage.deletes).toContain(
      storageFile(STREAM_LOG_SUMMARIES_DIR, 'delete-me'),
    );
  });

  it('flushes unrelated dirty streams when delete cancels a pending save', async () => {
    const storage = mockStorage({
      logs: {},
      summaries: {},
    });
    const store = await StreamLogStore.open();

    vi.useFakeTimers();
    try {
      appendTranscriptEntry(
        store,
        'alpha',
        namedEntry('alpha-entry', 500, 'must persist'),
      );

      await store.delete('beta');

      expect(storage.writes.has(storageFile(STREAM_LOGS_DIR, 'alpha'))).toBe(
        true,
      );
      expect(
        storage.writes.has(storageFile(STREAM_LOG_SUMMARIES_DIR, 'alpha')),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a stream id to be reused after a deleted in-flight write', async () => {
    const storage = mockStorage({
      logs: {},
      summaries: {},
      pauseLogWriteKey: 'reuse-me',
    });
    const store = await StreamLogStore.open();

    appendTranscriptEntry(
      store,
      'reuse-me',
      namedEntry('old-entry', 500, 'old entry'),
    );

    await flushAcrossDelete(store, storage, 'reuse-me');

    appendTranscriptEntry(
      store,
      'reuse-me',
      namedEntry('new-entry', 700, 'new entry'),
    );
    await store.flush();

    expect(writtenLog(storage.writes, 'reuse-me')).toEqual([
      expect.objectContaining({
        id: 'new-entry',
        text: 'new entry',
      }),
    ]);
    expect(writtenSummary(storage.writes, 'reuse-me')).toEqual(
      settledSummary(700, 700),
    );
  });

  it('writes stream summaries with dirty log flushes', async () => {
    const storage = mockStorage({ logs: {}, summaries: {} });
    const store = await StreamLogStore.open();

    appendTranscriptEntry(
      store,
      'new-stream',
      namedEntry('new-stream-entry', 500, 'new entry'),
    );
    await store.flush();

    expect(writtenLog(storage.writes, 'new-stream')).toHaveLength(1);
    expect(writtenSummary(storage.writes, 'new-stream')).toEqual(
      settledSummary(500, 500),
    );
  });

  it('preserves unparseable persisted entries when appending after rehydrate', async () => {
    const unknownFutureEntry = {
      seqNo: 2,
      id: 'alpha-future',
      type: 'future-entry-type',
      level: LOG_LEVELS.INFO,
      timestamp: 150,
      futurePayload: { ok: true },
    };
    const malformedEntry = {
      seqNo: 4,
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 300,
      text: 'missing id',
    };
    const storage = mockStorage({
      logs: {
        alpha: [
          logEntry('alpha', 1, 100),
          unknownFutureEntry,
          logEntry('alpha', 3, 200),
          malformedEntry,
        ],
      },
      summaries: {
        alpha: summary(100, 200, { hasRunningGroup: false }),
      },
    });
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const store = await StreamLogStore.open();
    await store.ensureLoaded('alpha');

    expect(
      store
        .get('alpha')
        ?.getRange(0)
        .map((entry) => entry.id),
    ).toEqual(['alpha-1', 'alpha-3']);
    // Loud read (#7464): the preserved rows are invisible to the typed view,
    // so the load says they exist rather than silently hiding them.
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamLogStore',
      expect.stringContaining(
        'Stream alpha: 2 persisted transcript entries did not parse',
      ),
    );

    appendTranscriptEntry(
      store,
      'alpha',
      namedEntry('alpha-new', 400, 'new entry'),
    );
    await store.flush();

    expect(writtenLog(storage.writes, 'alpha')).toEqual([
      expect.objectContaining({ id: 'alpha-1', seqNo: 1 }),
      unknownFutureEntry,
      expect.objectContaining({ id: 'alpha-3', seqNo: 2 }),
      malformedEntry,
      expect.objectContaining({ id: 'alpha-new', seqNo: 3 }),
    ]);
  });

  it('keeps an unknown-only stream loadable so a later save preserves it', async () => {
    const unknownEntry = {
      seqNo: 1,
      id: 'beta-future',
      type: 'future-entry-type',
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      data: { text: 'not understood by this version' },
    };
    const storage = mockStorage({
      logs: {
        beta: [unknownEntry],
      },
      summaries: {},
    });
    const store = await StreamLogStore.open();

    expect(store.keys()).toEqual(['beta']);
    expect(store.get('beta')).toBeUndefined();

    await store.ensureLoaded('beta');
    appendTranscriptEntry(
      store,
      'beta',
      namedEntry('beta-new', 200, 'new entry'),
    );
    await store.flush();

    expect(writtenLog(storage.writes, 'beta')).toEqual([
      unknownEntry,
      expect.objectContaining({ id: 'beta-new', seqNo: 1 }),
    ]);
  });

  it('surfaces a non-array stream read and refuses memory-only appends', async () => {
    const storage = mockStorage({
      logs: { gamma: { corrupted: 'not an array' } },
      summaries: {
        gamma: summary(100, 200, { hasRunningGroup: false }),
      },
    });
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const store = await StreamLogStore.open();
    await expect(store.ensureLoaded('gamma')).rejects.toThrow(
      'persisted log is not an array',
    );

    // Parses-but-not-an-array is corrupt, not an empty log: the load fails
    // loudly, exactly like unparseable JSON.
    expect(store.get('gamma')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamLogStore',
      expect.stringContaining('Failed to reload stream gamma from disk'),
    );

    // Writer-only mutation surfaces the refusal at acquisition: a stream
    // whose persisted log failed to load has no resident log, so no writer
    // (and therefore no memory-only append) can be obtained.
    expect(() =>
      appendTranscriptEntry(
        store,
        'gamma',
        namedEntry('gamma-new', 400, 'new entry'),
      ),
    ).toThrow('Cannot acquire a writer for released stream gamma');

    expect(writtenLog(storage.writes, 'gamma')).toBeUndefined();
    expect(storage.writes.size).toBe(0);
  });

  it('rejects flush when authoritative transcript writes fail', async () => {
    mockStorage({
      logs: {},
      summaries: {},
      logWriteError: new Error('authoritative transcript write denied'),
    });
    const store = await StreamLogStore.open();
    appendTranscriptEntry(store, 'alpha', logEntry('alpha', 1, 200));

    await expect(store.flush()).rejects.toThrow(
      'Transcript flush failed after 3 retries',
    );
  });

  it('writes dirty transcripts sequentially', async () => {
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const storage = mockStorage({
      logs: {},
      summaries: {},
      onLogWrite: async () => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        await delay(1);
        activeWrites -= 1;
      },
    });
    const store = await StreamLogStore.open();
    for (const streamId of ['alpha', 'beta', 'gamma']) {
      appendTranscriptEntry(store, streamId, logEntry(streamId, 1, 200));
    }

    await store.flush();

    expect(maximumActiveWrites).toBe(1);
    expect(
      ['alpha', 'beta', 'gamma'].every((streamId) =>
        storage.writes.has(storageFile(STREAM_LOGS_DIR, streamId)),
      ),
    ).toBe(true);
  });

  it('fails persistent opening for a corrupt startup log', async () => {
    const storage = mockStorage({
      logs: { delta: [] },
      summaries: {},
      rawLogJson: { delta: '[{"id":' },
    });
    await expect(StreamLogStore.open()).rejects.toThrow(SyntaxError);
    expect(storage.writes.size).toBe(0);
  });
});

describe('StreamLogStore save throttle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes periodically under sustained sub-window appends and drains on flush', async () => {
    let logWrites = 0;
    const storage = mockStorage({
      logs: {},
      summaries: {},
      onLogWrite: () => {
        logWrites += 1;
      },
    });
    const store = await StreamLogStore.open();
    vi.useFakeTimers();

    const writer = store.acquireWriter('alpha', 'execution-alpha');
    writer.append(namedEntry('m1', 1, ''));
    // 20 chunks 100ms apart: a trailing debounce would reset its timer on
    // every append and never write until the stream pauses; the max-wait
    // throttle must produce a durable write per 300ms window regardless.
    for (let i = 0; i < 20; i += 1) {
      writer.appendText('m1', `chunk-${i} `);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(logWrites).toBeGreaterThanOrEqual(5);

    // The tail landed after the last periodic write; flush drains it.
    const writesBeforeFlush = logWrites;
    writer.close();
    await store.flush();
    expect(logWrites).toBeGreaterThan(writesBeforeFlush);
    expect(writtenLog(storage.writes, 'alpha')[0]?.text).toBe(
      Array.from({ length: 20 }, (_, i) => `chunk-${i} `).join(''),
    );
  });

  it('bounds the durability gap to one throttle window for a first append', async () => {
    const storage = mockStorage({ logs: {}, summaries: {} });
    const store = await StreamLogStore.open();
    vi.useFakeTimers();

    const writer = store.acquireWriter('alpha', 'execution-alpha');
    writer.append(namedEntry('m1', 1, 'first entry'));
    expect(writtenLog(storage.writes, 'alpha')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(300);
    expect(writtenLog(storage.writes, 'alpha')).toHaveLength(1);
    writer.close();
  });

  it('queues a save window that fires while a write batch is in flight', async () => {
    const bothWritesLanded = createDeferred();
    let logWrites = 0;
    const storage = mockStorage({
      logs: {},
      summaries: {},
      pauseLogWriteKey: 'alpha',
      onLogWrite: () => {
        logWrites += 1;
        if (logWrites === 2) bothWritesLanded.resolve();
      },
    });
    const store = await StreamLogStore.open();
    vi.useFakeTimers();

    const writer = store.acquireWriter('alpha', 'execution-alpha');
    writer.append(namedEntry('m1', 1, ''));
    writer.appendText('m1', 'first ');
    await vi.advanceTimersByTimeAsync(300);
    await storage.waitForPausedWrite();

    // Mutate while the first batch's write hangs, and let a second window
    // fire. An unserialized second batch would persist the newer snapshot
    // during the pause and then get clobbered when the paused older write
    // completes last; the queued batch must instead run after it.
    writer.appendText('m1', 'second');
    await vi.advanceTimersByTimeAsync(300);
    storage.releasePausedWrite();
    await bothWritesLanded.promise;
    writer.close();
    await store.flush();

    expect(writtenLog(storage.writes, 'alpha')[0]?.text).toBe('first second');
  });

  it('drains an in-flight write batch before a discarding reload', async () => {
    const storage = mockStorage({
      logs: {},
      summaries: {},
      pauseLogWriteKey: 'alpha',
    });
    const store = await StreamLogStore.open();
    vi.useFakeTimers();

    const writer = store.acquireWriter('alpha', 'execution-alpha');
    writer.append(namedEntry('m1', 1, 'first'));
    await vi.advanceTimersByTimeAsync(300);
    await storage.waitForPausedWrite();

    // A rollback reload must not resolve while a write batch is still
    // running against the pre-rollback adapters.
    let reloaded = false;
    const reload = store.reload({ discardPendingWrites: true }).then(() => {
      reloaded = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(reloaded).toBe(false);

    storage.releasePausedWrite();
    await reload;
    expect(reloaded).toBe(true);
    writer.close();
  });
});

describe('StreamLogStore summary metadata mirror', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const META = {
    identity: { kind: 'agent' as const, agent: 'polish' },
    executionId: 'exec-1',
    parentStreamId: 'parent-stream',
    description: 'Polish the draft',
    model: 'deepseekproT',
  };

  it('round-trips recorded summary metadata through the persisted cache', async () => {
    const storage = mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: { alpha: summary(200, 200) },
    });
    const store = await StreamLogStore.open();

    store.recordSummaryMeta('alpha', META);
    expect(store.getSummaryMeta('alpha')).toEqual(META);
    await waitForCondition(
      () => writtenSummary(storage.writes, 'alpha') !== undefined,
    );
    const persisted = writtenSummary(storage.writes, 'alpha') as Record<
      string,
      unknown
    >;
    expect(persisted).toMatchObject({ firstTimestamp: 200, meta: META });

    // A fresh open serves the widened fields from the persisted cache alone.
    vi.restoreAllMocks();
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: { alpha: persisted },
    });
    const reopened = await StreamLogStore.open();
    expect(reopened.getSummaryMeta('alpha')).toEqual(META);
  });

  it('drains a queued metadata write before a discard-pending reload', async () => {
    const summaryWriteStarted = createDeferred();
    const releaseSummaryWrite = createDeferred();
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: { alpha: summary(200, 200) },
      onSummaryWrite: async (streamId) => {
        if (streamId !== 'alpha') return;
        summaryWriteStarted.resolve();
        await releaseSummaryWrite.promise;
      },
    });
    const store = await StreamLogStore.open();

    store.recordSummaryMeta('alpha', META);
    await summaryWriteStarted.promise;

    let reloaded = false;
    const reload = store.reload({ discardPendingWrites: true }).then(() => {
      reloaded = true;
    });
    await delay(0);
    expect(reloaded).toBe(false);

    releaseSummaryWrite.resolve();
    await reload;
    expect(reloaded).toBe(true);
  });

  it('discards a stale-shaped summary cache loudly and rebuilds from the log', async () => {
    const storage = mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {
        alpha: { ...summary(200, 200), meta: 'not-an-object' },
      },
    });
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});

    const store = await StreamLogStore.open();

    // Rebuilt (full log read), never migrated in place.
    expect(storage.fullLogReads()).toBe(1);
    expect(store.keys()).toEqual(['alpha']);
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(store.getSummaryMeta('alpha')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamLogStore',
      expect.stringContaining('stale-shaped summary cache'),
    );
  });

  it('holds metadata for an unregistered stream without minting a tab and lands it on registration', async () => {
    mockStorage({ logs: {}, summaries: {} });
    const store = await StreamLogStore.open();

    store.recordSummaryMeta('gamma', META);
    // Not registered: the antechamber never mints a phantom tab...
    expect(store.has('gamma')).toBe(false);
    expect(store.keys()).toEqual([]);
    // ...but the metadata is already readable, because run facts can
    // legitimately project before registration.
    expect(store.getSummaryMeta('gamma')).toEqual(META);

    store.ensureStream('gamma');
    expect(store.has('gamma')).toBe(true);
    expect(store.getSummaryMeta('gamma')).toEqual(META);
    await store.flush();
  });
});
