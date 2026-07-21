import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MESSAGE_TYPES, type StreamTabId } from '@shared/schemas';
import { createRunTrace, StreamLogStore } from '@transcript';
import type { TranscriptWriter } from '@transcript/StreamLogStore';

describe('createRunTrace dispose', () => {
  let store: StreamLogStore;

  beforeEach(() => {
    store = StreamLogStore.ephemeral('test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes the flusher from its owning session set on dispose', () => {
    vi.useFakeTimers();
    const flushers = new Map<string, () => void>();
    const handle = createRunTrace('disposed-stream', store, flushers);
    const stream = handle.trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);

    stream.append('a');
    // Chunk is throttled (49ms window), but the owning session set reaches it.
    for (const flush of flushers.values()) flush();
    expect(store.get('disposed-stream')?.getRange(0)[0]?.text).toBe('a');

    handle.dispose();

    // After dispose: more chunks should not reach the store via the global
    // flusher (because the flusher was removed from `activeFlushers`).
    // Append another chunk and confirm the owning set no longer pushes
    // it through. The chunk would still flush via its own per-stream timer,
    // so we verify by sampling before the timer fires.
    stream.append('b');
    for (const flush of flushers.values()) flush();
    // Only the 'a' chunk should be visible — the 'b' chunk hasn't been
    // pushed because the flusher was unregistered and the throttled timer
    // hasn't fired.
    expect(store.get('disposed-stream')?.getRange(0)[0]?.text).toBe('a');
  });

  it('returns the same dispose function across the handle', () => {
    const handle = createRunTrace('idempotent-stream', store);
    handle.dispose();
    // Calling dispose again should not throw and should be a no-op.
    expect(() => handle.dispose()).not.toThrow();
  });

  it('hands a latched cleanup failure to the execution durability flusher', () => {
    vi.useFakeTimers();
    const failure = new Error('delayed transcript write failed');
    const writer: TranscriptWriter = {
      streamId: 'failed-stream' as StreamTabId,
      append: vi.fn((entry) => ({ ...entry, seqNo: 0 })),
      update: vi.fn(),
      appendText: vi.fn(() => {
        throw failure;
      }),
      close: vi.fn(),
    };
    const flushers = new Map<string, () => void>();
    const handle = createRunTrace(
      writer.streamId,
      store,
      flushers,
      'execution-failed',
      writer,
    );
    const stream = handle.trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    stream.append('first');
    stream.append('second');
    vi.advanceTimersByTime(50);

    expect(() => handle.dispose()).not.toThrow();
    expect(flushers.has('execution-failed')).toBe(true);
    expect(() => flushers.get('execution-failed')?.()).toThrow(failure);
    expect(flushers.has('execution-failed')).toBe(false);
    expect(writer.close).toHaveBeenCalledOnce();
  });

  it('closes a reserved writer when subscriber setup fails', () => {
    const setupFailure = new Error('writer identity unavailable');
    const close = vi.fn();
    const writer = {
      get streamId(): StreamTabId {
        throw setupFailure;
      },
      append: vi.fn(),
      update: vi.fn(),
      appendText: vi.fn(),
      close,
    } satisfies TranscriptWriter;

    expect(() =>
      createRunTrace(
        'setup-failed' as StreamTabId,
        store,
        new Map(),
        'execution-setup-failed',
        writer,
      ),
    ).toThrow(setupFailure);
    expect(close).toHaveBeenCalledOnce();
  });
});
