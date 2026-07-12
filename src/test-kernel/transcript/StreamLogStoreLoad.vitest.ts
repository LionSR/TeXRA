// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Platform imports
import { FileType, type FileStat } from '@platform/interfaces';

import {
  StreamLogStore,
  STREAM_LOGS_DIR,
  STREAM_LOG_SUMMARIES_DIR,
} from '@transcript';
import * as logUtils from '@logger/logUtils';
import {
  END_GROUP_STATUS,
  LOG_LEVELS,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type StreamLogEntry,
} from '@shared/schemas';
import { StorageFS } from '@utils/files';
import { delay } from '@utils/core';

interface MockStorageOptions {
  /** Values are usually arrays; non-array values simulate corrupt logs. */
  logs: Record<string, unknown>;
  summaries: Record<string, unknown>;
  rawLogJson?: Record<string, string>;
  rawSummaryJson?: Record<string, string>;
  logMtimes?: Record<string, number>;
  summaryMtimes?: Record<string, number>;
  onLogRead?: (key: string) => Promise<void> | void;
  pauseLogWriteKey?: string;
}

function storageFile(dir: string, key: string): string {
  return path.join(dir, `${encodeURIComponent(key)}.json`);
}

function streamKeyFromFile(target: string): string {
  return decodeURIComponent(path.basename(target).replace(/\.json$/, ''));
}

function notFound(): NodeJS.ErrnoException {
  const error = new Error('not found') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function logEntry(
  streamId: string,
  seqNo: number,
  timestamp: number,
): StreamLogEntry {
  return {
    seqNo,
    id: `${streamId}-${seqNo}`,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp,
    messageType: MESSAGE_TYPES.DEFAULT,
    text: `${streamId} entry ${seqNo}`,
  };
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
  logMtimes = {},
  summaryMtimes = {},
  onLogRead,
  pauseLogWriteKey,
}: MockStorageOptions): {
  deletes: string[];
  fullLogReads: () => number;
  releasePausedWrite: () => void;
  waitForPausedWrite: () => Promise<void>;
  writes: Map<string, unknown>;
} {
  let fullLogReads = 0;
  let pausedLogWriteUsed = false;
  let releasePausedWriteImpl = (): void => {};
  let markPausedWriteStarted = (): void => {};
  const waitForPausedWrite =
    pauseLogWriteKey == null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          markPausedWriteStarted = resolve;
        });
  const deletes: string[] = [];
  const writes = new Map<string, unknown>();

  vi.spyOn(StorageFS, 'readDir').mockImplementation(async (target) => {
    if (target !== STREAM_LOGS_DIR) throw notFound();
    return Object.keys(logs).map((key) => [
      `${encodeURIComponent(key)}.json`,
      FileType.File,
    ]);
  });

  // KVStore now calls StorageFS.read (raw string) via the Keyv adapter;
  // return JSON strings so the custom deserializer can parse them.
  vi.spyOn(StorageFS, 'read').mockImplementation(async (target) => {
    const key = streamKeyFromFile(target);

    if (target.startsWith(`${STREAM_LOG_SUMMARIES_DIR}${path.sep}`)) {
      if (!Object.hasOwn(summaries, key)) throw notFound();
      return rawSummaryJson[key] ?? JSON.stringify(summaries[key]);
    }

    if (target.startsWith(`${STREAM_LOGS_DIR}${path.sep}`)) {
      if (!Object.hasOwn(logs, key)) throw notFound();
      fullLogReads += 1;
      await onLogRead?.(key);
      return rawLogJson[key] ?? JSON.stringify(logs[key]);
    }

    throw new Error(`Unexpected read target: ${target}`);
  });

  vi.spyOn(StorageFS, 'ensureDir').mockResolvedValue(undefined);
  vi.spyOn(StorageFS, 'exists').mockImplementation(async (target) => {
    const key = streamKeyFromFile(target);
    if (target.startsWith(`${STREAM_LOG_SUMMARIES_DIR}${path.sep}`)) {
      return Object.hasOwn(summaries, key);
    }
    if (target.startsWith(`${STREAM_LOGS_DIR}${path.sep}`)) {
      return Object.hasOwn(logs, key);
    }
    throw new Error(`Unexpected exists target: ${target}`);
  });
  vi.spyOn(StorageFS, 'stat').mockImplementation(async (target) => {
    const key = streamKeyFromFile(target);
    if (target.startsWith(`${STREAM_LOG_SUMMARIES_DIR}${path.sep}`)) {
      if (!Object.hasOwn(summaries, key)) throw notFound();
      return fileStat(summaryMtimes[key] ?? 2);
    }
    if (target.startsWith(`${STREAM_LOGS_DIR}${path.sep}`)) {
      if (!Object.hasOwn(logs, key)) throw notFound();
      return fileStat(logMtimes[key] ?? 1);
    }
    throw new Error(`Unexpected stat target: ${target}`);
  });
  const recordWrite = async (
    target: string,
    content: string | Uint8Array,
  ): Promise<void> => {
    if (
      pauseLogWriteKey != null &&
      !pausedLogWriteUsed &&
      target === storageFile(STREAM_LOGS_DIR, pauseLogWriteKey)
    ) {
      pausedLogWriteUsed = true;
      markPausedWriteStarted();
      await new Promise<void>((resolve) => {
        releasePausedWriteImpl = resolve;
      });
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
    deletes.push(target);
    writes.delete(target);
  });

  return {
    deletes,
    fullLogReads: () => fullLogReads,
    releasePausedWrite: () => releasePausedWriteImpl(),
    waitForPausedWrite: () => waitForPausedWrite,
    writes,
  };
}

async function waitForCondition(
  condition: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await delay(0);
  }
  throw new Error(message);
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

  it('constructs an inspectable ephemeral store only with an explicit reason', async () => {
    const store = StreamLogStore.ephemeral('interactive fallback test');

    store.append('ephemeral-stream', logEntry('ephemeral-stream', 1, 100));
    store.releaseEntries('ephemeral-stream');
    await store.flush();

    expect(store.mode).toEqual({
      kind: 'ephemeral',
      reason: 'interactive fallback test',
    });
    expect(store.get('ephemeral-stream')?.size).toBe(1);
    expect(() => StreamLogStore.ephemeral('  ')).toThrow('requires a reason');
  });

  it('rejects when persistent storage cannot be opened', async () => {
    vi.spyOn(StorageFS, 'ensureDir').mockRejectedValue(
      new Error('storage permission denied'),
    );

    await expect(StreamLogStore.open()).rejects.toThrow(
      'storage permission denied',
    );
  });

  it('preserves live state when a transactional reload fails', async () => {
    const logs: Record<string, unknown> = {
      alpha: [logEntry('alpha', 1, 100)],
    };
    mockStorage({
      logs,
      summaries: {
        alpha: {
          firstTimestamp: 100,
          lastTimestamp: 100,
          hasRunningGroup: false,
        },
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

  it('uses stream summaries without reading full log files at startup', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 200), logEntry('alpha', 2, 250)],
        beta: [logEntry('beta', 1, 100), logEntry('beta', 2, 160)],
      },
      summaries: {
        alpha: {
          firstTimestamp: 200,
          lastTimestamp: 250,
          hasRunningGroup: false,
        },
        beta: {
          firstTimestamp: 100,
          lastTimestamp: 160,
          hasRunningGroup: false,
        },
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

  it('salvages valid fields from partially corrupt summaries', async () => {
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

    expect(storage.fullLogReads()).toBe(0);
    expect(store.keys()).toEqual(['alpha']);
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(store.getLastTimestamp('alpha')).toBeUndefined();
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
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'alpha')),
    ).toEqual({
      firstTimestamp: 200,
      lastTimestamp: 250,
      hasRunningGroup: false,
      hasRunningStreamingText: false,
    });
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
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'alpha')),
    ).toEqual({
      firstTimestamp: 200,
      lastTimestamp: 250,
      hasRunningGroup: false,
      hasRunningStreamingText: false,
    });
  });

  it('rebuilds stale summaries before trusting them', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 200), logEntry('alpha', 2, 250)],
      },
      summaries: {
        alpha: {
          firstTimestamp: 1,
          lastTimestamp: 1,
          hasRunningGroup: false,
        },
      },
      logMtimes: { alpha: 20 },
      summaryMtimes: { alpha: 10 },
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(1);
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'alpha')),
    ).toEqual({
      firstTimestamp: 200,
      lastTimestamp: 250,
      hasRunningGroup: false,
      hasRunningStreamingText: false,
    });
  });

  it('rehydrates summarized streams with stale running groups', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [runningGroupEntry('alpha', 1, 100)],
      },
      summaries: {
        alpha: {
          firstTimestamp: 100,
          lastTimestamp: 100,
          hasRunningGroup: true,
        },
      },
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(0);

    const affected = await store.endRunningGroups(300);
    await store.flush();
    const entry = store.get('alpha')?.getRange(0).at(0);

    expect(affected).toEqual(['alpha']);
    expect(storage.fullLogReads()).toBe(1);
    expect(entry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    // endRunningGroups() defaults to RUN_OUTCOME.FAILED (#7993 step 2) — the
    // orphan sweep's caller-classified default, not the folded 'error'
    // EndGroupStatus string.
    expect(entry?.data).toEqual({ status: RUN_OUTCOME.FAILED, endTime: 300 });
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'alpha')),
    ).toEqual({
      firstTimestamp: 100,
      lastTimestamp: 100,
      hasRunningGroup: false,
      hasRunningStreamingText: false,
    });
  });

  it('can close running groups for only selected summarized streams', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [runningGroupEntry('alpha', 1, 100)],
        beta: [runningGroupEntry('beta', 1, 110)],
      },
      summaries: {
        alpha: {
          firstTimestamp: 100,
          lastTimestamp: 100,
          hasRunningGroup: true,
        },
        beta: {
          firstTimestamp: 110,
          lastTimestamp: 110,
          hasRunningGroup: true,
        },
      },
    });

    const store = await StreamLogStore.open();

    const affected = await store.endRunningGroupsForStreams(['alpha'], 300);
    await store.flush();

    expect(affected).toEqual(['alpha']);
    expect(storage.fullLogReads()).toBe(1);
    expect(store.get('alpha')?.getRange(0).at(0)?.type).toBe(
      STREAM_LOG_ENTRY_TYPES.GROUP_END,
    );
    expect(store.get('beta')).toBeUndefined();
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'alpha')),
    ).toEqual({
      firstTimestamp: 100,
      lastTimestamp: 100,
      hasRunningGroup: false,
      hasRunningStreamingText: false,
    });
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'beta')),
    ).toBeUndefined();
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
        gamma: {
          firstTimestamp: 100,
          lastTimestamp: 100,
          hasRunningGroup: false,
          hasRunningStreamingText: true,
        },
      },
    });

    const store = await StreamLogStore.open();

    expect(storage.fullLogReads()).toBe(0);

    const affected = await store.endRunningGroupsForStreams(['gamma'], 300);
    await store.flush();
    const entry = store.get('gamma')?.getRange(0).at(0);

    expect(affected).toEqual(['gamma']);
    expect(storage.fullLogReads()).toBe(1);
    expect(entry?.data).toEqual({ status: 'completed' });
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'gamma')),
    ).toEqual({
      firstTimestamp: 100,
      lastTimestamp: 100,
      hasRunningGroup: false,
      hasRunningStreamingText: false,
    });
  });

  it('can close selected running groups with a caller-supplied RunOutcome', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [runningGroupEntry('alpha', 1, 100)],
      },
      summaries: {
        alpha: {
          firstTimestamp: 100,
          lastTimestamp: 100,
          hasRunningGroup: true,
        },
      },
    });

    const store = await StreamLogStore.open();

    // A caller-supplied RunOutcome (e.g. restart repair's graceful-interrupt
    // classification, #7993 step 2) reaches the row directly — no fold to
    // the legacy 2-value EndGroupStatus.
    const affected = await store.endRunningGroupsForStreams(
      ['alpha'],
      300,
      RUN_OUTCOME.CANCELLED,
    );
    await store.flush();

    expect(affected).toEqual(['alpha']);
    expect(store.get('alpha')?.getRange(0).at(0)?.data).toEqual({
      status: RUN_OUTCOME.CANCELLED,
      endTime: 300,
    });
    expect(storage.fullLogReads()).toBe(1);
  });

  // §8.3 boundary normalization: the ONE app-side read boundary for legacy
  // GROUP_START/GROUP_END `data.status` wire values a pre-cutover writer left
  // on disk. Every live producer now writes canonical StreamPhase/RunOutcome
  // values directly (#7993 step 2), so this is the backfill path for rows
  // that were already persisted before the cutover.
  it('normalizes legacy persisted GROUP_END status at the read boundary (#7993 step 2)', async () => {
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
    // 'running' is string-identical to StreamPhase.RUNNING (row 1, §8.2) —
    // passes through unnormalized, retype-only.
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
        alpha: {
          firstTimestamp: 100,
          lastTimestamp: 100,
          hasRunningGroup: false,
        },
        beta: {
          firstTimestamp: 110,
          lastTimestamp: 110,
          hasRunningGroup: true,
        },
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
    expect(store.get('beta')?.getRange(0).at(0)?.type).toBe(
      STREAM_LOG_ENTRY_TYPES.GROUP_END,
    );
  });

  it('bounds stale running group rehydrates', async () => {
    const streamIds = Array.from(
      { length: 20 },
      (_, index) => `stream-${index}`,
    );
    let releaseReads: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
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
        await readGate;
        activeReads -= 1;
      },
    });

    const store = await StreamLogStore.open();

    const endRunningGroups = store.endRunningGroups(300);
    await waitForCondition(
      () => storage.fullLogReads() === 8,
      'Expected stale stream rehydrate reads to reach the concurrency cap',
    );

    expect(maxActiveReads).toBe(8);

    releaseReads();
    const affected = await endRunningGroups;
    await store.flush();

    expect(affected).toHaveLength(streamIds.length);
    expect(maxActiveReads).toBe(8);
    expect(storage.fullLogReads()).toBe(streamIds.length);
  });

  it('settles save waiters when dirty streams are still rehydrating', async () => {
    let releaseRead: () => void = () => {};
    let markReadStarted: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 100)],
      },
      summaries: {
        alpha: {
          firstTimestamp: 100,
          lastTimestamp: 100,
          hasRunningGroup: false,
        },
      },
      onLogRead: async () => {
        markReadStarted();
        await readGate;
      },
    });
    const store = await StreamLogStore.open();
    const load = store.ensureLoaded('alpha');
    await readStarted;

    vi.useFakeTimers();
    try {
      store.append('alpha', {
        id: 'alpha-live-entry',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 200,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'live while loading',
      });
      const save = store.save();
      const settled = vi.fn();
      save.then(settled);

      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();

      expect(settled).toHaveBeenCalledOnce();
    } finally {
      releaseRead();
      await load;
      await store.flush();
      vi.useRealTimers();
    }
  });

  it('lets delete win over an in-flight stream write', async () => {
    const storage = mockStorage({
      logs: {},
      summaries: {},
      pauseLogWriteKey: 'delete-me',
    });
    const store = await StreamLogStore.open();

    store.append('delete-me', {
      id: 'delete-me-entry',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 500,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'soon deleted',
    });

    const flush = store.flush();
    await storage.waitForPausedWrite();
    const deletion = store.delete('delete-me');
    storage.releasePausedWrite();
    await Promise.all([flush, deletion]);

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
      store.append('alpha', {
        id: 'alpha-entry',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 500,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'must persist',
      });
      const save = store.save();
      const settled = vi.fn();
      save.then(settled);

      await store.delete('beta');
      await Promise.resolve();

      expect(settled).toHaveBeenCalledOnce();
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

    store.append('reuse-me', {
      id: 'old-entry',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 500,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'old entry',
    });

    const flush = store.flush();
    await storage.waitForPausedWrite();
    const deletion = store.delete('reuse-me');
    storage.releasePausedWrite();
    await Promise.all([flush, deletion]);

    store.append('reuse-me', {
      id: 'new-entry',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 700,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'new entry',
    });
    await store.flush();

    expect(
      storage.writes.get(storageFile(STREAM_LOGS_DIR, 'reuse-me')),
    ).toEqual([
      expect.objectContaining({
        id: 'new-entry',
        text: 'new entry',
      }),
    ]);
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'reuse-me')),
    ).toEqual({
      firstTimestamp: 700,
      lastTimestamp: 700,
      hasRunningGroup: false,
      hasRunningStreamingText: false,
    });
  });

  it('writes stream summaries with dirty log flushes', async () => {
    const storage = mockStorage({ logs: {}, summaries: {} });
    const store = await StreamLogStore.open();

    store.append('new-stream', {
      id: 'new-stream-entry',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 500,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'new entry',
    });
    await store.flush();

    expect(
      storage.writes.get(storageFile(STREAM_LOGS_DIR, 'new-stream')),
    ).toHaveLength(1);
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'new-stream')),
    ).toEqual({
      firstTimestamp: 500,
      lastTimestamp: 500,
      hasRunningGroup: false,
      hasRunningStreamingText: false,
    });
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
        alpha: {
          firstTimestamp: 100,
          lastTimestamp: 200,
          hasRunningGroup: false,
        },
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

    store.append('alpha', {
      id: 'alpha-new',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 400,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'new entry',
    });
    await store.flush();

    expect(storage.writes.get(storageFile(STREAM_LOGS_DIR, 'alpha'))).toEqual([
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
    store.append('beta', {
      id: 'beta-new',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 200,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'new entry',
    });
    await store.flush();

    expect(storage.writes.get(storageFile(STREAM_LOGS_DIR, 'beta'))).toEqual([
      unknownEntry,
      expect.objectContaining({ id: 'beta-new', seqNo: 1 }),
    ]);
  });

  it('surfaces a non-array stream read and refuses memory-only appends', async () => {
    const storage = mockStorage({
      logs: { gamma: { corrupted: 'not an array' } },
      summaries: {
        gamma: {
          firstTimestamp: 100,
          lastTimestamp: 200,
          hasRunningGroup: false,
        },
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

    expect(() =>
      store.append('gamma', {
        id: 'gamma-new',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 400,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'new entry',
      }),
    ).toThrow('failed to load');

    expect(
      storage.writes.get(storageFile(STREAM_LOGS_DIR, 'gamma')),
    ).toBeUndefined();
    expect(storage.writes.size).toBe(0);
  });

  it('rejects flush when a concurrent append cannot join persisted history', async () => {
    const storage = mockStorage({
      logs: { gamma: { corrupted: 'not an array' } },
      summaries: {
        gamma: {
          firstTimestamp: 100,
          lastTimestamp: 100,
          hasRunningGroup: false,
        },
      },
    });
    const store = await StreamLogStore.open();
    const load = store.ensureLoaded('gamma');

    store.append('gamma', {
      id: 'gamma-concurrent',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 200,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'arrived while the persisted transcript was being read',
    });

    await expect(load).rejects.toThrow('persisted log is not an array');
    await expect(store.flush()).rejects.toThrow(
      'persisted transcripts failed to load',
    );
    expect(storage.writes.size).toBe(0);
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
