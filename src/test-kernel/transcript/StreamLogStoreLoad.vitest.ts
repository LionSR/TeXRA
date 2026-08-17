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
  StreamLogEntrySchema,
  type StreamLogEntry,
} from '@shared/schemas';
import { createDeferred, waitForCondition } from '@test/support/asyncTestUtils';
import { appendTranscriptEntry } from '@test/support/storeTestDrivers';
import {
  ephemeralTranscriptWarning,
  StreamLogStore,
  STREAM_LOGS_DIR,
  type StreamLogAppendInput,
} from '@transcript';
import { delay } from '@utils/core';
import { StorageFS } from '@utils/files/storageFS';

const LEGACY_STREAM_LOG_SUMMARIES_DIR = 'streamLogSummaries';

interface MockStorageOptions {
  /** Values are usually arrays; non-array values simulate corrupt logs. */
  logs: Record<string, unknown>;
  summaries: Record<string, unknown>;
  journals?: Record<string, string>;
  rawLogJson?: Record<string, string>;
  logReadError?: Error;
  logWriteError?: Error;
  logDeleteError?: Error;
  onLogRead?: (key: string) => Promise<void> | void;
  onLogWrite?: (key: string) => Promise<void> | void;
  onCheckpointWrite?: (key: string) => Promise<void> | void;
  pauseLogWriteKey?: string;
}

function storageFile(dir: string, key: string): string {
  return path.join(dir, `${encodeURIComponent(key)}.json`);
}

function journalFile(dir: string, key: string): string {
  return path.join(dir, `${encodeURIComponent(key)}.jsonl`);
}

function isJournalFile(target: string): boolean {
  return target.endsWith('.jsonl');
}

/** Which of the two stream-log directories a mocked target file lives in. */
function areaOf(target: string): 'log' | 'summary' | null {
  if (target.startsWith(`${LEGACY_STREAM_LOG_SUMMARIES_DIR}${path.sep}`)) {
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
  return decodeURIComponent(path.basename(target).replace(/\.jsonl?$/, ''));
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
  return StreamLogEntrySchema.parse({
    ...namedEntry(
      `${streamId}-${seqNo}`,
      timestamp,
      `${streamId} entry ${seqNo}`,
    ),
    seqNo,
  });
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

function journalWithCheckpoint(
  entries: readonly StreamLogEntry[],
  checkpoint: Record<string, unknown>,
): string {
  return `${[
    {
      version: 1,
      opId: '11111111-1111-4111-8111-111111111111',
      op: 'seed',
      entries,
    },
    {
      version: 1,
      opId: '22222222-2222-4222-8222-222222222222',
      op: 'checkpoint',
      summary: checkpoint,
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')}\n`;
}

function writtenSummary(
  writes: ReadonlyMap<string, unknown>,
  streamId: string,
): unknown {
  return writtenJournal(writes, streamId).findLast(
    (record) =>
      typeof record === 'object' &&
      record !== null &&
      (record as { op?: unknown }).op === 'checkpoint',
  )?.summary;
}

function writtenJournal(
  writes: ReadonlyMap<string, unknown>,
  streamId: string,
): Array<Record<string, unknown>> {
  const raw = writes.get(journalFile(STREAM_LOGS_DIR, streamId));
  if (typeof raw !== 'string') return [];
  return raw
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writtenMutations(
  writes: ReadonlyMap<string, unknown>,
  streamId: string,
): Array<Record<string, unknown>> {
  return writtenJournal(writes, streamId).filter(
    (record) => record.op !== 'checkpoint',
  );
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
  journals: initialJournals = {},
  rawLogJson = {},
  logReadError,
  logWriteError,
  logDeleteError,
  onLogRead,
  onLogWrite,
  onCheckpointWrite,
  pauseLogWriteKey,
}: MockStorageOptions): {
  deletePersistedStream: (streamId: string) => void;
  deletes: string[];
  ensuredDirs: string[];
  fullLogReads: () => number;
  releasePausedWrite: () => void;
  setLogDeleteError: (error: Error | undefined) => void;
  waitForPausedWrite: () => Promise<void>;
  writes: Map<string, unknown>;
} {
  let fullLogReads = 0;
  let activeLogDeleteError = logDeleteError;
  let pausedLogWriteUsed = false;
  const pausedWriteStarted = createDeferred();
  const pausedWriteRelease = createDeferred();
  const deletes: string[] = [];
  const ensuredDirs: string[] = [];
  const writes = new Map<string, unknown>();
  const journals: Record<string, string> = { ...initialJournals };
  const projectedLogs: Record<string, unknown[]> = {};

  vi.spyOn(StorageFS, 'readDir').mockImplementation(async (target) => {
    if (target === LEGACY_STREAM_LOG_SUMMARIES_DIR) {
      return Object.keys(summaries).map(
        (key) =>
          [`${encodeURIComponent(key)}.json`, FileType.File] as [
            string,
            number,
          ],
      );
    }
    if (target !== STREAM_LOGS_DIR) throw notFound();
    return [
      ...Object.keys(logs).map(
        (key) =>
          [`${encodeURIComponent(key)}.json`, FileType.File] as [
            string,
            number,
          ],
      ),
      ...Object.keys(journals).map(
        (key) =>
          [`${encodeURIComponent(key)}.jsonl`, FileType.File] as [
            string,
            number,
          ],
      ),
    ];
  });

  // KVStore reads raw strings through StorageFS, so hand back JSON
  // text for its deserializer to parse.
  vi.spyOn(StorageFS, 'read').mockImplementation(async (target) => {
    const key = streamKeyFromFile(target);

    if (areaOf(target) === 'summary') {
      if (!Object.hasOwn(summaries, key)) throw notFound();
      return JSON.stringify(summaries[key]);
    }

    if (areaOf(target) === 'log') {
      if (isJournalFile(target)) {
        if (!Object.hasOwn(journals, key)) throw notFound();
        fullLogReads += 1;
        await onLogRead?.(key);
        return journals[key];
      }
      if (!Object.hasOwn(logs, key)) throw notFound();
      fullLogReads += 1;
      if (logReadError) throw logReadError;
      await onLogRead?.(key);
      return rawLogJson[key] ?? JSON.stringify(logs[key]);
    }

    throw new Error(`Unexpected read target: ${target}`);
  });
  vi.spyOn(StorageFS, 'readTail').mockImplementation(
    async (target, maxBytes) => {
      const key = streamKeyFromFile(target);
      if (areaOf(target) !== 'log' || !isJournalFile(target)) {
        throw new Error(`Unexpected tail-read target: ${target}`);
      }
      if (!Object.hasOwn(journals, key)) throw notFound();
      return journals[key].slice(-maxBytes);
    },
  );

  vi.spyOn(StorageFS, 'ensureDir').mockImplementation(async (target) => {
    ensuredDirs.push(target);
  });
  vi.spyOn(StorageFS, 'exists').mockImplementation(async (target) => {
    const key = streamKeyFromFile(target);
    if (areaOf(target) === 'summary') return Object.hasOwn(summaries, key);
    if (areaOf(target) === 'log') {
      return isJournalFile(target)
        ? Object.hasOwn(journals, key)
        : Object.hasOwn(logs, key);
    }
    throw new Error(`Unexpected exists target: ${target}`);
  });
  vi.spyOn(StorageFS, 'stat').mockImplementation(async (target) => {
    const key = streamKeyFromFile(target);
    if (areaOf(target) === 'summary') {
      if (!Object.hasOwn(summaries, key)) throw notFound();
      return fileStat(2);
    }
    if (areaOf(target) === 'log') {
      if (
        isJournalFile(target)
          ? !Object.hasOwn(journals, key)
          : !Object.hasOwn(logs, key)
      )
        throw notFound();
      return fileStat(1);
    }
    throw new Error(`Unexpected stat target: ${target}`);
  });
  const recordWrite = async (
    target: string,
    content: string | Uint8Array,
  ): Promise<void> => {
    if (logWriteError && areaOf(target) === 'log') throw logWriteError;
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

    const text =
      typeof content === 'string'
        ? content
        : Buffer.from(content).toString('utf8');
    if (areaOf(target) === 'log' && isJournalFile(target)) {
      const key = streamKeyFromFile(target);
      journals[key] = text;
      writes.set(target, text);
      for (const line of text.trimEnd().split('\n')) {
        if (!line) continue;
        const record = JSON.parse(line) as {
          op: string;
          entries?: unknown[];
        };
        if (record.op === 'seed') {
          projectedLogs[key] = structuredClone(record.entries ?? []);
          writes.set(storageFile(STREAM_LOGS_DIR, key), projectedLogs[key]);
        }
      }
      return;
    }
    writes.set(target, JSON.parse(text));
  };
  vi.spyOn(StorageFS, 'write').mockImplementation(recordWrite);
  vi.spyOn(StorageFS, 'writeAtomic').mockImplementation(recordWrite);
  vi.spyOn(StorageFS, 'appendFile').mockImplementation(
    async (target, content) => {
      if (logWriteError && areaOf(target) === 'log') throw logWriteError;
      const key = streamKeyFromFile(target);
      if (
        pauseLogWriteKey != null &&
        !pausedLogWriteUsed &&
        target === journalFile(STREAM_LOGS_DIR, pauseLogWriteKey)
      ) {
        pausedLogWriteUsed = true;
        pausedWriteStarted.resolve();
        await pausedWriteRelease.promise;
      }
      const text =
        typeof content === 'string'
          ? content
          : Buffer.from(content).toString('utf8');
      journals[key] = (journals[key] ?? '') + text;
      writes.set(target, journals[key]);
      // Keep the existing test helper's projected view in sync.
      const projected =
        projectedLogs[key] ??
        (Array.isArray(logs[key]) ? structuredClone(logs[key]) : []);
      for (const line of text.trimEnd().split('\n')) {
        if (!line) continue;
        const record = JSON.parse(line) as {
          op: string;
          entry?: StreamLogEntry;
          id?: string;
          patch?: Record<string, unknown>;
          text?: string;
          settled?: boolean;
        };
        if (record.op === 'ensure') continue;
        if (record.op === 'checkpoint') {
          await onCheckpointWrite?.(key);
          continue;
        }
        if (record.op === 'append' && record.entry) {
          projected.push(record.entry);
          continue;
        }
        const entry = projected.find(
          (value): value is Record<string, unknown> =>
            typeof value === 'object' &&
            value !== null &&
            (value as Record<string, unknown>).id === record.id,
        );
        if (!entry) continue;
        if (record.op === 'update' && record.patch) {
          Object.assign(entry, record.patch);
          if (record.settled && entry.settlementSeqNo === undefined) {
            entry.settlementSeqNo =
              Math.max(
                projected.length,
                0,
                ...projected.map((value) =>
                  typeof value === 'object' && value !== null
                    ? (((value as Record<string, unknown>).settlementSeqNo as
                        number | undefined) ?? 0)
                    : 0,
                ),
              ) + 1;
          }
        }
      }
      projectedLogs[key] = projected;
      writes.set(storageFile(STREAM_LOGS_DIR, key), projected);
      await onLogWrite?.(key);
    },
  );
  vi.spyOn(StorageFS, 'delete').mockImplementation(async (target) => {
    if (activeLogDeleteError && areaOf(target) === 'log') {
      throw activeLogDeleteError;
    }
    deletes.push(target);
    writes.delete(target);
    if (areaOf(target) === 'log') {
      const key = streamKeyFromFile(target);
      if (isJournalFile(target)) delete journals[key];
      else delete logs[key];
      if (isJournalFile(target) || !Object.hasOwn(journals, key)) {
        delete projectedLogs[key];
      }
    }
  });

  return {
    deletePersistedStream: (streamId) => {
      delete logs[streamId];
      delete journals[streamId];
      delete projectedLogs[streamId];
    },
    deletes,
    ensuredDirs,
    fullLogReads: () => fullLogReads,
    releasePausedWrite: () => pausedWriteRelease.resolve(),
    setLogDeleteError: (error) => {
      activeLogDeleteError = error;
    },
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

    const second = await StreamLogStore.open();
    expect(second.keys()).toEqual(['registered-empty']);
    expect(second.get('registered-empty')).toBeUndefined();

    const third = await StreamLogStore.open();
    expect(third.keys()).toEqual(['registered-empty']);
    expect(storage.fullLogReads()).toBe(0);
  });

  it('replays append-only mutations over an unchanged legacy array', async () => {
    const legacy = [logEntry('alpha', 1, 100)];
    const storage = mockStorage({
      logs: { alpha: structuredClone(legacy) },
      summaries: { alpha: summary(100, 100) },
    });
    const first = await StreamLogStore.open();
    await first.ensureLoaded('alpha');
    const writer = first.acquireWriter('alpha', 'execution-alpha');
    writer.update('alpha-1', { level: LOG_LEVELS.ERROR });
    writer.appendText('alpha-1', ' resumed');
    writer.settle('alpha-1', {});
    writer.close();
    await first.flush();

    expect(writtenMutations(storage.writes, 'alpha')).toMatchObject([
      { op: 'seed' },
      { op: 'update', id: 'alpha-1', settled: false },
      {
        op: 'update',
        id: 'alpha-1',
        settled: true,
        patch: { text: 'alpha entry 1 resumed' },
      },
    ]);

    const reopened = await StreamLogStore.open();
    await reopened.ensureLoaded('alpha');
    expect(reopened.get('alpha')?.getRange(0)).toMatchObject([
      {
        id: 'alpha-1',
        level: LOG_LEVELS.ERROR,
        text: 'alpha entry 1 resumed',
      },
    ]);
  });

  it('distinguishes another process deletion from a stale local summary', async () => {
    const logs: Record<string, unknown> = { alpha: [] };
    const storage = mockStorage({ logs, summaries: {} });

    const staleProcessStore = await StreamLogStore.open();
    expect(staleProcessStore.has('alpha')).toBe(true);
    await expect(
      staleProcessStore.hasAuthoritativeStream('alpha'),
    ).resolves.toBe(true);

    // A different process commits deletion while this store retains the
    // summary it loaded at startup.
    storage.deletePersistedStream('alpha');

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
    let reads = 0;
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: false }),
      },
      onLogRead: async () => {
        reads += 1;
        if (reads !== 2) return;
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

  it('persists metadata recorded while rehydration is in flight', async () => {
    const meta = {
      identity: { kind: 'agent' as const, agent: 'polish' },
      executionId: 'racing-metadata',
      description: 'Recorded during rehydration',
    };
    const readStarted = createDeferred();
    const readGate = createDeferred();
    const storage = mockStorage({
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
    const loading = store.ensureLoaded('alpha');
    await readStarted.promise;

    store.recordSummaryMeta('alpha', meta);
    readGate.resolve();
    await loading;

    await waitForCondition(
      () => writtenSummary(storage.writes, 'alpha') !== undefined,
    );
    expect(writtenSummary(storage.writes, 'alpha')).toMatchObject({ meta });
  });

  it('keeps a writer-owned rehydrate resident when focus clears eviction', async () => {
    const readStarted = createDeferred();
    const readGate = createDeferred();
    let reads = 0;
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: false }),
      },
      onLogRead: async () => {
        reads += 1;
        if (reads !== 2) return;
        readStarted.resolve();
        await readGate.promise;
      },
    });
    const store = await StreamLogStore.open();
    store.requestEviction('alpha');
    const writerPromise = store.loadAndAcquireWriter('alpha', 'late-writer');
    await readStarted.promise;

    const focus = store.ensureLoaded('alpha');
    readGate.resolve();
    const writer = await writerPromise;
    await focus;
    writer.close();

    expect(store.get('alpha')?.size).toBe(1);
  });

  it('releases only the presentation lease that owns its token', async () => {
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: false }),
      },
    });
    const store = await StreamLogStore.open();
    const first = await store.ensureLoaded('alpha', {
      retainForPresentation: true,
    });
    const second = await store.ensureLoaded('alpha', {
      retainForPresentation: true,
    });

    store.requestEviction('alpha');
    first.close();
    expect(store.get('alpha')?.size).toBe(1);

    second.close();
    expect(store.get('alpha')).toBeUndefined();
    // Obsolete close is idempotent and cannot affect a later owner.
    first.close();
    expect(store.get('alpha')).toBeUndefined();
  });

  it('evicts a historical transcript when its final presentation closes', async () => {
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: false }),
      },
    });
    const store = await StreamLogStore.open();
    const lease = await store.ensureLoaded('alpha', {
      retainForPresentation: true,
    });

    expect(store.get('alpha')?.size).toBe(1);
    lease.close();

    expect(store.get('alpha')).toBeUndefined();
  });

  it('honors eviction requested while a focused rehydrate is pending', async () => {
    const readStarted = createDeferred();
    const readGate = createDeferred();
    let reads = 0;
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: false }),
      },
      onLogRead: async () => {
        reads += 1;
        if (reads !== 2) return;
        readStarted.resolve();
        await readGate.promise;
      },
    });
    const store = await StreamLogStore.open();
    const loading = store.ensureLoaded('alpha');
    await readStarted.promise;

    store.requestEviction('alpha');
    readGate.resolve();
    await loading;

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

  it('isolates an unreadable authoritative transcript for explicit retry', async () => {
    const failure = new Error('authoritative transcript read denied');
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {},
      logReadError: failure,
    });

    const store = await StreamLogStore.open();

    expect(store.keys()).toEqual(['alpha']);
    await expect(store.ensureLoaded('alpha')).rejects.toBe(failure);
  });

  it('retains the stream registry when authoritative log deletion fails', async () => {
    const storage = mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {
        alpha: { firstTimestamp: 200, lastTimestamp: 200 },
      },
    });
    const store = await StreamLogStore.open();
    storage.setLogDeleteError(new Error('log delete denied'));

    await expect(store.delete('alpha')).rejects.toThrow('log delete denied');

    expect(store.keys()).toEqual(['alpha']);
    expect(store.has('alpha')).toBe(true);
  });

  it('isolates a corrupt stream during reload without dropping valid streams', async () => {
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
    logs.beta = { corrupted: true };

    await store.reload();

    expect(store.keys()).toEqual(['alpha', 'beta']);
    expect(store.getTimestampRange('alpha').first).toBe(100);
    await expect(store.ensureLoaded('beta')).rejects.toThrow(
      'persisted log is not an array',
    );
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

  it('loads trailing checkpoints at startup without reading full journals', async () => {
    const alphaEntries = [logEntry('alpha', 1, 200), logEntry('alpha', 2, 250)];
    const betaEntries = [logEntry('beta', 1, 100), logEntry('beta', 2, 160)];
    const storage = mockStorage({
      logs: {},
      summaries: {},
      journals: {
        alpha: journalWithCheckpoint(
          alphaEntries,
          summary(200, 250, { hasRunningGroup: false }),
        ),
        beta: journalWithCheckpoint(
          betaEntries,
          summary(100, 160, { hasRunningGroup: false }),
        ),
      },
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(0);
    expect(store.keys()).toEqual(['beta', 'alpha']);
    expect(store.get('alpha')).toBeUndefined();
    expect(store.getTimestampRange('alpha')).toEqual({ first: 200, last: 250 });

    await store.ensureLoaded('alpha');

    expect(storage.fullLogReads()).toBe(1);
    expect(store.get('alpha')?.size).toBe(2);
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

  it('rehydrates cold streams with stale running groups', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [
          {
            ...runningGroupEntry('alpha', 1, 100),
            // Pre-#10774 writers settled GROUP_START rows immediately.
            settlementSeqNo: 1,
          },
        ],
      },
      summaries: {
        alpha: summary(100, 100, { hasRunningGroup: true }),
      },
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(1);

    const affected = await store.endRunningGroupsForStreams(['alpha'], 300);
    await store.flush();
    expect(store.get('alpha')).toBeUndefined();
    expect(storage.fullLogReads()).toBe(2);
    const entry = writtenLog(storage.writes, 'alpha').at(0);

    expect(affected).toEqual(['alpha']);
    expect(entry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    // endRunningGroupsForStreams() defaults to RUN_OUTCOME.FAILED, the orphan
    // sweep's caller-classified default.
    expect(entry?.data).toEqual({ status: RUN_OUTCOME.FAILED, endTime: 300 });
    const reloaded = await StreamLogStore.open();
    await reloaded.ensureLoaded('alpha');
    expect(reloaded.get('alpha')?.getRange(0).at(0)?.presentationSeqNo).toBe(1);
    expect(writtenSummary(storage.writes, 'alpha')).toEqual(
      settledSummary(100, 100),
    );
  });

  it('reports unfinished streams without making transcripts resident', async () => {
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
    expect(storage.fullLogReads()).toBe(3);
  });

  it('can close running groups for only selected cold streams', async () => {
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
    expect(storage.fullLogReads()).toBe(3);
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
    expect(storage.fullLogReads()).toBe(2);
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

    expect(storage.fullLogReads()).toBe(1);

    const affected = await store.endRunningGroupsForStreams(['gamma'], 300);
    await store.flush();
    expect(store.get('gamma')).toBeUndefined();
    expect(storage.fullLogReads()).toBe(2);
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
    expect(storage.fullLogReads()).toBe(2);
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
      settlementSeqNo: 3,
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
    expect(
      entries.find((e) => e.id === 'delta-legacy-running')?.settlementSeqNo,
    ).toBeUndefined();
    expect(
      entries.find((e) => e.id === 'delta-legacy-running')?.presentationSeqNo,
    ).toBe(3);
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
    expect(storage.fullLogReads()).toBe(3);
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
    const readsByStream = new Map<string, number>();

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
      onLogRead: async (streamId) => {
        const reads = (readsByStream.get(streamId) ?? 0) + 1;
        readsByStream.set(streamId, reads);
        if (reads === 1) return;
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await readGate.promise;
        activeReads -= 1;
      },
    });

    const store = await StreamLogStore.open();

    const endRunningGroups = store.endRunningGroupsForStreams(streamIds, 300);
    await waitForCondition(() => storage.fullLogReads() === 28, {
      timeoutMessage:
        'Expected stale stream rehydrate reads to reach the concurrency cap',
    });

    expect(maxActiveReads).toBe(8);

    readGate.resolve();
    const affected = await endRunningGroups;
    await store.flush();

    expect(affected).toHaveLength(streamIds.length);
    expect(maxActiveReads).toBe(8);
    expect(storage.fullLogReads()).toBe(streamIds.length * 2);
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
      storage.writes.has(
        storageFile(LEGACY_STREAM_LOG_SUMMARIES_DIR, 'delete-me'),
      ),
    ).toBe(false);
    expect(storage.deletes).toContain(
      storageFile(STREAM_LOGS_DIR, 'delete-me'),
    );
    expect(storage.deletes).toContain(
      storageFile(LEGACY_STREAM_LOG_SUMMARIES_DIR, 'delete-me'),
    );
  });

  it('lets delete drain a legacy load before removing its seed journal', async () => {
    const loadStarted = createDeferred();
    const releaseLoad = createDeferred();
    let reads = 0;
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: { alpha: summary(100, 100) },
      onLogRead: async () => {
        reads += 1;
        if (reads !== 2) return;
        loadStarted.resolve();
        await releaseLoad.promise;
      },
    });
    const store = await StreamLogStore.open();

    const load = store.ensureLoaded('alpha');
    await loadStarted.promise;
    const deletion = store.delete('alpha');
    releaseLoad.resolve();
    await Promise.all([load, deletion]);

    expect(store.has('alpha')).toBe(false);
    expect((await StreamLogStore.open()).has('alpha')).toBe(false);
  });

  it('lets delete drain a direct legacy read before removing its seed journal', async () => {
    const readStarted = createDeferred();
    const releaseRead = createDeferred();
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: { alpha: summary(100, 100) },
      onLogRead: async () => {
        readStarted.resolve();
        await releaseRead.promise;
      },
    });
    const store = await StreamLogStore.open();

    const read = store.readEntries('alpha');
    await readStarted.promise;
    const deletion = store.delete('alpha');
    releaseRead.resolve();
    await Promise.all([read, deletion]);

    expect(store.has('alpha')).toBe(false);
    expect((await StreamLogStore.open()).has('alpha')).toBe(false);
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
      expect(writtenSummary(storage.writes, 'alpha')).toEqual(
        settledSummary(500, 500),
      );
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

  it('writes summary checkpoints with dirty log flushes', async () => {
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
      // Legacy rows remain byte-for-byte in the base array; JSONL records
      // carry their live sequence and are renumbered only when replayed.
      expect.objectContaining({ id: 'alpha-3', seqNo: 3 }),
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

  it('registers a non-array authoritative stream as failed', async () => {
    const storage = mockStorage({
      logs: { gamma: { corrupted: 'not an array' } },
      summaries: {
        gamma: summary(100, 200, { hasRunningGroup: false }),
      },
    });
    const store = await StreamLogStore.open();

    expect(store.keys()).toEqual(['gamma']);
    await expect(store.ensureLoaded('gamma')).rejects.toThrow(
      'persisted log is not an array',
    );
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

  it('flushes healthy streams before reporting a failed-load stream', async () => {
    const storage = mockStorage({ logs: {}, summaries: {} });
    const store = await StreamLogStore.open();
    appendTranscriptEntry(store, 'blocked', logEntry('blocked', 1, 100));
    appendTranscriptEntry(store, 'healthy', logEntry('healthy', 1, 200));

    const state = (
      store as unknown as {
        streams: Map<string, { loadFailed?: boolean }>;
      }
    ).streams.get('blocked');
    if (!state) throw new Error('Expected blocked stream state');
    state.loadFailed = true;

    await expect(store.flush()).rejects.toThrow(
      'skipped 1 stream(s) whose persisted transcript failed to load',
    );
    expect(writtenLog(storage.writes, 'healthy')).toHaveLength(1);
  });

  it('persists unrelated transcripts independently', async () => {
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

    expect(maximumActiveWrites).toBe(3);
    expect(
      ['alpha', 'beta', 'gamma'].every((streamId) =>
        storage.writes.has(storageFile(STREAM_LOGS_DIR, streamId)),
      ),
    ).toBe(true);
  });
});

describe('StreamLogStore append-only persistence', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('repairs a valid journal record that lacks its final newline', async () => {
    const seed = JSON.stringify({
      version: 1,
      opId: '11111111-1111-4111-8111-111111111111',
      op: 'seed',
      entries: [logEntry('alpha', 1, 100)],
    });
    const storage = mockStorage({
      logs: {},
      summaries: {},
      journals: { alpha: seed },
    });

    const store = await StreamLogStore.open();
    await store.ensureLoaded('alpha');

    expect(storage.writes.get(journalFile(STREAM_LOGS_DIR, 'alpha'))).toBe(
      `${seed}\n`,
    );
    expect(store.get('alpha')?.getRange(0).at(0)?.id).toBe('alpha-1');
  });

  it('ignores an invalid update record without corrupting its entry', async () => {
    const journal = [
      {
        version: 1,
        opId: '11111111-1111-4111-8111-111111111111',
        op: 'seed',
        entries: [logEntry('alpha', 1, 100)],
      },
      {
        version: 1,
        opId: '22222222-2222-4222-8222-222222222222',
        op: 'update',
        id: 'alpha-1',
        patch: { text: 42 },
        settled: true,
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');
    mockStorage({
      logs: {},
      summaries: {},
      journals: { alpha: `${journal}\n` },
    });

    const store = await StreamLogStore.open();
    await store.ensureLoaded('alpha');

    expect(store.get('alpha')?.getRange(0).at(0)).toMatchObject({
      id: 'alpha-1',
      text: 'alpha entry 1',
    });
  });

  it('preserves invalid overlay records when replacing a legacy array', async () => {
    const invalidRecord = {
      version: 1,
      opId: '22222222-2222-4222-8222-222222222222',
      op: 'future-operation',
      payload: { keep: true },
    };
    const append = {
      version: 1,
      opId: '11111111-1111-4111-8111-111111111111',
      op: 'append',
      entry: logEntry('alpha', 2, 200),
      settled: false,
    };
    const storage = mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: {},
      journals: {
        alpha: `${JSON.stringify(invalidRecord)}\n${JSON.stringify(append)}\n`,
      },
    });

    await StreamLogStore.open();

    expect(writtenJournal(storage.writes, 'alpha')).toEqual([
      expect.objectContaining({
        op: 'seed',
        entries: expect.arrayContaining([invalidRecord]),
      }),
    ]);
  });

  it('loads a seeded journal without parsing a corrupt retired array', async () => {
    const seed = JSON.stringify({
      version: 1,
      opId: '11111111-1111-4111-8111-111111111111',
      op: 'seed',
      entries: [logEntry('alpha', 1, 100)],
    });
    const storage = mockStorage({
      logs: { alpha: [] },
      summaries: {},
      rawLogJson: { alpha: '{"corrupt":' },
      journals: { alpha: `${seed}\n` },
    });

    const store = await StreamLogStore.open();
    await store.ensureLoaded('alpha');

    expect(store.get('alpha')?.getRange(0).at(0)?.id).toBe('alpha-1');
    expect(storage.deletes).toContain(storageFile(STREAM_LOGS_DIR, 'alpha'));
  });

  it('persists streaming text only when the whole entry settles', async () => {
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
    // Chunk-level records are deliberately not durable: independently
    // redacted chunks can preserve a secret split across chunk boundaries.
    for (let i = 0; i < 20; i += 1) {
      writer.appendText('m1', `chunk-${i} `);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(logWrites).toBe(1);

    // Settlement materializes and persists the whole-buffer text once.
    writer.settle('m1', {});
    writer.close();
    await store.flush();
    expect(logWrites).toBe(2);
    expect(writtenLog(storage.writes, 'alpha')[0]?.text).toBe(
      Array.from({ length: 20 }, (_, i) => `chunk-${i} `).join(''),
    );
  });

  it('starts persistence on the next event-loop turn for a first append', async () => {
    const storage = mockStorage({ logs: {}, summaries: {} });
    const store = await StreamLogStore.open();
    vi.useFakeTimers();

    const writer = store.acquireWriter('alpha', 'execution-alpha');
    writer.append(namedEntry('m1', 1, 'first entry'));
    expect(writtenLog(storage.writes, 'alpha')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(0);
    expect(writtenLog(storage.writes, 'alpha')).toHaveLength(1);
    writer.close();
  });

  it('serializes a later mutation behind an in-flight append', async () => {
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
    writer.update('m1', { text: 'first ' });
    await vi.advanceTimersByTimeAsync(0);
    await storage.waitForPausedWrite();

    // Mutate while the first append hangs. A concurrent append could land
    // out of order; the later mutation must instead run after it.
    writer.update('m1', { text: 'first second' });
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
    await storage.waitForPausedWrite();

    // A rollback reload must not resolve while an append is still
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

  it('releases a writer that starts after terminal eviction once its flush is durable', async () => {
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: { alpha: summary(100, 100) },
    });
    const store = await StreamLogStore.open();

    store.requestEviction('alpha');
    const writer = await store.loadAndAcquireWriter('alpha', 'late-writer');
    writer.append(namedEntry('late', 200, 'late write'));
    writer.close();

    expect(store.get('alpha')?.size).toBe(2);
    await store.flush();
    expect(store.get('alpha')).toBeUndefined();
  });

  it('keeps a cold stream resident when no eviction was requested', async () => {
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: { alpha: summary(100, 100) },
    });
    const store = await StreamLogStore.open();

    const writer = await store.loadAndAcquireWriter('alpha', 'active-writer');
    writer.append(namedEntry('active', 200, 'active write'));
    writer.close();
    await store.flush();

    expect(store.get('alpha')?.size).toBe(2);
  });

  it('does not retain eviction state for an unknown stream', async () => {
    mockStorage({ logs: {}, summaries: {} });
    const store = await StreamLogStore.open();

    store.requestEviction('unknown');
    store.ensureStream('unknown');
    await store.flush();

    expect(store.get('unknown')).toBeDefined();
  });

  it('prunes an empty stream after its final writer closes', async () => {
    mockStorage({ logs: {}, summaries: {} });
    const store = await StreamLogStore.open();
    const writer = store.acquireWriter('unknown', 'empty-writer');
    writer.close();

    store.requestEviction('unknown');
    store.ensureStream('unknown');
    await store.flush();

    expect(store.get('unknown')).toBeDefined();
  });

  it('reads cold entries without making the stream resident', async () => {
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 100)] },
      summaries: { alpha: summary(100, 100) },
    });
    const store = await StreamLogStore.open();

    await expect(store.readEntries('alpha')).resolves.toEqual([
      expect.objectContaining({ id: 'alpha-1' }),
    ]);
    expect(store.get('alpha')).toBeUndefined();
  });
});

describe('StreamLogStore metadata checkpoints', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const META = {
    identity: { kind: 'agent' as const, agent: 'polish' },
    executionId: 'a77e77',
    parentStreamId: 'parent-stream',
    description: 'Polish the draft',
    model: 'deepseekproT',
  };

  it('retains legacy metadata when checkpoint import fails', async () => {
    const storage = mockStorage({
      logs: {},
      journals: {
        alpha: `${JSON.stringify({
          version: 1,
          opId: '11111111-1111-4111-8111-111111111111',
          op: 'seed',
          entries: [logEntry('alpha', 1, 200)],
        })}\n`,
      },
      summaries: {
        alpha: { ...summary(200, 200), meta: META },
      },
      logWriteError: new Error('checkpoint append denied'),
    });

    const store = await StreamLogStore.open();

    expect(store.getSummaryMeta('alpha')).toEqual(META);
    expect(storage.deletes).not.toContain(LEGACY_STREAM_LOG_SUMMARIES_DIR);
  });

  it('round-trips recorded summary metadata through persistence', async () => {
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
    expect(storage.deletes).toContain(LEGACY_STREAM_LOG_SUMMARIES_DIR);
    const persistedJournal = storage.writes.get(
      journalFile(STREAM_LOGS_DIR, 'alpha'),
    );
    expect(typeof persistedJournal).toBe('string');

    // A fresh open serves the metadata from the canonical journal alone.
    vi.restoreAllMocks();
    mockStorage({
      logs: {},
      summaries: {},
      journals: { alpha: persistedJournal as string },
    });
    const reopened = await StreamLogStore.open();
    expect(reopened.getSummaryMeta('alpha')).toEqual(META);
  });

  it('carries metadata with the immediate log append', async () => {
    const storage = mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: { alpha: summary(200, 200) },
    });
    const store = await StreamLogStore.open();

    await store.ensureLoaded('alpha');
    appendTranscriptEntry(store, 'alpha', logEntry('alpha', 2, 300));
    store.recordSummaryMeta('alpha', META);
    await delay(0);

    expect(writtenMutations(storage.writes, 'alpha')).toEqual([
      expect.objectContaining({ op: 'seed' }),
      expect.objectContaining({
        op: 'append',
        entry: expect.objectContaining({ id: 'alpha-2' }),
      }),
    ]);

    await store.flush();
    expect(writtenSummary(storage.writes, 'alpha')).toMatchObject({
      lastTimestamp: 300,
      meta: META,
    });
  });

  it('drains a queued metadata write before a discard-pending reload', async () => {
    const summaryWriteStarted = createDeferred();
    const releaseSummaryWrite = createDeferred();
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: { alpha: summary(200, 200) },
      onCheckpointWrite: async (streamId) => {
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

  it('drops metadata awaiting a stream that is absent after reload', async () => {
    mockStorage({ logs: {}, summaries: {} });
    const store = await StreamLogStore.open();
    store.recordSummaryMeta('old-root-stream', META);

    await store.reload({ discardPendingWrites: true });

    expect(store.getSummaryMeta('old-root-stream')).toBeUndefined();
  });

  it('preserves metadata recorded while reload reads are in flight', async () => {
    const reloadReadStarted = createDeferred();
    const releaseReloadRead = createDeferred();
    let reads = 0;
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {},
      onLogRead: async () => {
        reads += 1;
        if (reads === 2) {
          reloadReadStarted.resolve();
          await releaseReloadRead.promise;
        }
      },
    });
    const store = await StreamLogStore.open();

    const reload = store.reload({ discardPendingWrites: true });
    await reloadReadStarted.promise;
    store.recordSummaryMeta('new-run', META);
    releaseReloadRead.resolve();

    await expect(reload).rejects.toThrow('state changed during reload');
    expect(store.getSummaryMeta('new-run')).toEqual(META);
  });

  it('preserves metadata recorded while reload flushes pending writes', async () => {
    const summaryWriteStarted = createDeferred();
    const releaseSummaryWrite = createDeferred();
    mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: { alpha: summary(200, 200) },
      onCheckpointWrite: async (streamId) => {
        if (streamId !== 'alpha') return;
        summaryWriteStarted.resolve();
        await releaseSummaryWrite.promise;
      },
    });
    const store = await StreamLogStore.open();
    await store.ensureLoaded('alpha');
    appendTranscriptEntry(store, 'alpha', logEntry('alpha', 2, 300));

    const reload = store.reload();
    await summaryWriteStarted.promise;
    store.recordSummaryMeta('new-run', META);
    releaseSummaryWrite.resolve();

    await expect(reload).rejects.toThrow('state changed during reload');
    expect(store.getSummaryMeta('new-run')).toEqual(META);
  });

  it('ignores stale-shaped legacy summary metadata', async () => {
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
    expect(store.getTimestampRange('alpha').first).toBe(200);
    expect(store.getSummaryMeta('alpha')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamLogStore',
      expect.stringContaining('stale-shaped legacy summary'),
    );
  });

  it('does not resurrect legacy metadata after an explicit clearing checkpoint', async () => {
    const journal = [
      {
        version: 1,
        opId: '11111111-1111-4111-8111-111111111111',
        op: 'seed',
        entries: [logEntry('alpha', 1, 200)],
      },
      {
        version: 1,
        opId: '22222222-2222-4222-8222-222222222222',
        op: 'checkpoint',
        summary: settledSummary(200, 200),
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');
    const storage = mockStorage({
      logs: {},
      summaries: { alpha: { ...summary(200, 200), meta: META } },
      journals: { alpha: `${journal}\n` },
    });

    const store = await StreamLogStore.open();

    expect(store.getSummaryMeta('alpha')).toBeUndefined();
    expect(storage.writes.has(journalFile(STREAM_LOGS_DIR, 'alpha'))).toBe(
      false,
    );
    expect(storage.deletes).toContain(LEGACY_STREAM_LOG_SUMMARIES_DIR);
  });

  it('discards a summary whose execution id violates the canonical schema', async () => {
    const storage = mockStorage({
      logs: { alpha: [logEntry('alpha', 1, 200)] },
      summaries: {
        alpha: {
          ...summary(200, 200),
          meta: { ...META, executionId: 'not-an-id' },
        },
      },
    });
    vi.spyOn(logUtils, 'warn').mockImplementation(() => {});

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(1);
    expect(store.getSummaryMeta('alpha')).toBeUndefined();
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
