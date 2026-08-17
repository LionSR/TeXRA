import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as logUtils from '@logger/logUtils';
import { MESSAGE_TYPES, type StreamTabId } from '@shared/schemas';
import { createRunTrace, StreamLogStore } from '@transcript';
import type { RunTraceFlushEntry } from '@transcript/runTrace';
import type { TranscriptWriter } from '@transcript/StreamLogStore';

describe('createRunTrace dispose', () => {
  let store: StreamLogStore;

  beforeEach(() => {
    store = StreamLogStore.ephemeral('test');
  });

  afterEach(() => {
    vi.useRealTimers();
    logUtils.setOutputChannelFactory(null);
  });

  it('disposes the per-run output channel on teardown', () => {
    const dispose = vi.fn();
    logUtils.setOutputChannelFactory(() => ({
      appendLine: vi.fn(),
      dispose,
    }));
    const handle = createRunTrace('channel-stream', store);

    handle.dispose();
    expect(dispose).toHaveBeenCalledOnce();

    handle.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('removes the flusher from its owning session set on dispose', () => {
    vi.useFakeTimers();
    const flushers = new Map<string, RunTraceFlushEntry>();
    const handle = createRunTrace('disposed-stream', store, flushers);
    const stream = handle.trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);

    stream.append('a');
    // Chunk is throttled (49ms window), but the owning session set reaches it.
    for (const entry of flushers.values()) entry.flush();
    expect(store.get('disposed-stream')?.getRange(0)[0]?.text).toBe('a');

    handle.dispose();

    // After dispose: more chunks should not reach the store via the global
    // flusher (because the flusher was removed from `activeFlushers`).
    // Append another chunk and confirm the owning set no longer pushes
    // it through. The chunk would still flush via its own per-stream timer,
    // so we verify by sampling before the timer fires.
    stream.append('b');
    for (const entry of flushers.values()) entry.flush();
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

  it('carries a latched cleanup failure through a successor trace', () => {
    vi.useFakeTimers();
    const failure = new Error('delayed transcript write failed');
    const writer: TranscriptWriter = {
      streamId: 'failed-stream' as StreamTabId,
      reserveSettlement: vi.fn(),
      append: vi.fn((entry) => ({ ...entry, seqNo: 0 })),
      appendSettled: vi.fn((entry) => ({ ...entry, seqNo: 0 })),
      update: vi.fn(),
      settle: vi.fn(),
      appendText: vi.fn(() => {
        throw failure;
      }),
      close: vi.fn(),
    };
    const flushers = new Map<string, RunTraceFlushEntry>();
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

    const successor = createRunTrace(
      writer.streamId,
      store,
      flushers,
      'execution-failed',
    );
    expect(flushers.get('execution-failed')?.state).toBe('active');
    expect(() => flushers.get('execution-failed')?.flush()).toThrow(failure);
    expect(() => successor.dispose()).not.toThrow();
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
      reserveSettlement: vi.fn(),
      append: vi.fn(),
      appendSettled: vi.fn(),
      update: vi.fn(),
      settle: vi.fn(),
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
