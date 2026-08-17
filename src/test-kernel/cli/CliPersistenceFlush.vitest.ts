// Guards the Stage-2 CLI persistence wiring (runChatTui load()/flush()): the
// debounced disk write only lands when flush() drains it, so the exit-path
// flush is load-bearing; and a store that never load()ed (one-shot/headless
// commands) must persist nothing so those paths stay byte-identical.

import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
} from '@shared/schemas';
import { appendTranscriptEntry } from '@test/support/storeTestDrivers';
import {
  StreamLogStore,
  STREAM_LOGS_DIR,
  type StreamLogAppendInput,
} from '@transcript';
import { StorageFS } from '@utils/files/storageFS';

function notFound(): NodeJS.ErrnoException {
  const error = new Error('not found') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

/** Spy StorageFS onto an in-memory, initially-empty workspace. */
function emptyStorage(): { writes: Map<string, unknown> } {
  const writes = new Map<string, unknown>();
  vi.spyOn(StorageFS, 'readDir').mockResolvedValue([]);
  vi.spyOn(StorageFS, 'read').mockRejectedValue(notFound());
  vi.spyOn(StorageFS, 'readJson').mockRejectedValue(notFound());
  vi.spyOn(StorageFS, 'ensureDir').mockResolvedValue(undefined);
  vi.spyOn(StorageFS, 'stat').mockRejectedValue(notFound());
  const recordWrite = async (
    target: string,
    content: string | Uint8Array,
  ): Promise<void> => {
    const text =
      typeof content === 'string'
        ? content
        : Buffer.from(content).toString('utf8');
    writes.set(target, target.endsWith('.jsonl') ? text : JSON.parse(text));
  };
  vi.spyOn(StorageFS, 'write').mockImplementation(recordWrite);
  vi.spyOn(StorageFS, 'writeAtomic').mockImplementation(recordWrite);
  vi.spyOn(StorageFS, 'appendFile').mockImplementation(
    async (target, content) => {
      const previous = writes.get(target);
      const text =
        typeof content === 'string'
          ? content
          : Buffer.from(content).toString('utf8');
      writes.set(
        target,
        `${typeof previous === 'string' ? previous : ''}${text}`,
      );
    },
  );
  vi.spyOn(StorageFS, 'delete').mockResolvedValue(undefined);
  return { writes };
}

function entry(id: string, text: string): StreamLogAppendInput {
  return {
    id,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 500,
    messageType: MESSAGE_TYPES.DEFAULT,
    text,
  };
}

describe('CLI StreamLog persistence (flush on exit is load-bearing)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists appended entries only once flush() drains the debounce window', async () => {
    const storage = emptyStorage();
    const store = await StreamLogStore.open();

    const streamId = 'reviewer@opus#e1';
    const journalFile = path.join(
      STREAM_LOGS_DIR,
      `${encodeURIComponent(streamId)}.jsonl`,
    );
    appendTranscriptEntry(store, streamId, entry('a', 'first'));
    appendTranscriptEntry(store, streamId, entry('b', 'second'));

    // The SAVE_DEBOUNCE_MS (300ms) timer has not fired in this synchronous
    // window, so nothing is on disk yet — this is exactly the tail the exit
    // path would lose without an explicit flush.
    expect(storage.writes.has(journalFile)).toBe(false);

    await store.flush();

    const journal = storage.writes.get(journalFile);
    expect(typeof journal).toBe('string');
    const records = String(journal)
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.op === 'append')).toEqual([
      expect.objectContaining({
        op: 'append',
        entry: expect.objectContaining({ id: 'a', text: 'first' }),
      }),
      expect.objectContaining({
        op: 'append',
        entry: expect.objectContaining({ id: 'b', text: 'second' }),
      }),
    ]);
  });

  it('writes nothing for an explicitly ephemeral store', async () => {
    const storage = emptyStorage();
    const store = StreamLogStore.ephemeral('test');

    // Ephemeral mode is deliberate and inspectable; it never reaches storage.
    appendTranscriptEntry(store, 'main@opus#e2', entry('x', 'headless'));
    await store.flush();

    expect(storage.writes.size).toBe(0);
  });
});
