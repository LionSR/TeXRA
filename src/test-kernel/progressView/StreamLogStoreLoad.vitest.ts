// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Platform imports
import { FileType, type FileStat } from '@platform/interfaces/filesystem';

// Local imports - progress persistence
import { StreamLogStore } from '@logger/StreamLogStore';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamLogEntry,
} from '@shared/schemas';
import { StorageFS } from '@utils/files';

const STREAM_LOGS_DIR = 'streamLogs';
const STREAM_LOG_SUMMARIES_DIR = 'streamLogSummaries';

interface MockStorageOptions {
  logs: Record<string, StreamLogEntry[]>;
  summaries: Record<string, unknown>;
  logMtimes?: Record<string, number>;
  summaryMtimes?: Record<string, number>;
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
  logMtimes = {},
  summaryMtimes = {},
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

  vi.spyOn(StorageFS, 'readJson').mockImplementation(async (target) => {
    const key = streamKeyFromFile(target);

    if (target.startsWith(`${STREAM_LOG_SUMMARIES_DIR}${path.sep}`)) {
      if (!Object.hasOwn(summaries, key)) throw notFound();
      return summaries[key] as never;
    }

    if (target.startsWith(`${STREAM_LOGS_DIR}${path.sep}`)) {
      if (!Object.hasOwn(logs, key)) throw notFound();
      fullLogReads += 1;
      return logs[key] as never;
    }

    throw new Error(`Unexpected readJson target: ${target}`);
  });

  vi.spyOn(StorageFS, 'ensureDir').mockResolvedValue(undefined);
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
  vi.spyOn(StorageFS, 'write').mockImplementation(async (target, content) => {
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
  });
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

describe('StreamLogStore load', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

    const store = new StreamLogStore();
    await store.load();

    expect(storage.fullLogReads()).toBe(0);
    expect(store.keys()).toEqual(['beta', 'alpha']);
    expect(store.get('alpha')).toBeUndefined();
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(store.getLastTimestamp('alpha')).toBe(250);

    await store.ensureLoaded('alpha');

    expect(storage.fullLogReads()).toBe(1);
    expect(store.get('alpha')?.size).toBe(2);
  });

  it('falls back once for missing summaries and writes the sidecar cache', async () => {
    const storage = mockStorage({
      logs: {
        alpha: [logEntry('alpha', 1, 200), logEntry('alpha', 2, 250)],
      },
      summaries: {},
    });

    const store = new StreamLogStore();
    await store.load();

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

    const store = new StreamLogStore();
    await store.load();

    expect(storage.fullLogReads()).toBe(1);
    expect(store.getFirstTimestamp('alpha')).toBe(200);
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'alpha')),
    ).toEqual({
      firstTimestamp: 200,
      lastTimestamp: 250,
      hasRunningGroup: false,
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

    const store = new StreamLogStore();
    await store.load();

    expect(storage.fullLogReads()).toBe(0);

    const affected = await store.endRunningGroups(300);
    await store.flush();
    const entry = store.get('alpha')?.getRange(0).at(0);

    expect(affected).toEqual(['alpha']);
    expect(storage.fullLogReads()).toBe(1);
    expect(entry?.type).toBe(STREAM_LOG_ENTRY_TYPES.GROUP_END);
    expect(entry?.data).toEqual({ status: 'error', endTime: 300 });
    expect(
      storage.writes.get(storageFile(STREAM_LOG_SUMMARIES_DIR, 'alpha')),
    ).toEqual({
      firstTimestamp: 100,
      lastTimestamp: 100,
      hasRunningGroup: false,
    });
  });

  it('lets delete win over an in-flight stream write', async () => {
    const storage = mockStorage({
      logs: {},
      summaries: {},
      pauseLogWriteKey: 'delete-me',
    });
    const store = new StreamLogStore();
    await store.load();

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

  it('allows a stream id to be reused after a deleted in-flight write', async () => {
    const storage = mockStorage({
      logs: {},
      summaries: {},
      pauseLogWriteKey: 'reuse-me',
    });
    const store = new StreamLogStore();
    await store.load();

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
    });
  });

  it('writes stream summaries with dirty log flushes', async () => {
    const storage = mockStorage({ logs: {}, summaries: {} });
    const store = new StreamLogStore();
    await store.load();

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
    });
  });
});
