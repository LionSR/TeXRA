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
    for (const entry of flushers.values()) entry.flush();
    expect(store.get('disposed-stream')?.getRange(0)[0]?.text).toBe('a');

    handle.dispose();

    // Detaching the recorder prevents subsequent chunks from reaching the store.
    stream.append('b');
    for (const entry of flushers.values()) entry.flush();
    expect(store.get('disposed-stream')?.getRange(0)[0]?.text).toBe('a');
  });

  it('returns the same dispose function across the handle', () => {
    const handle = createRunTrace('idempotent-stream', store);
    handle.dispose();
    // Calling dispose again should not throw and should be a no-op.
    expect(() => handle.dispose()).not.toThrow();
  });

  it('keeps a cleanup failure for the final durability flush', () => {
    vi.useFakeTimers();
    const failure = new Error('delayed transcript write failed');
    const writer: TranscriptWriter = {
      streamId: 'failed-stream' as StreamTabId,
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

    expect(flushers.get('execution-failed')?.state).toBe('failed');
    expect(() => flushers.get('execution-failed')?.flush()).toThrow(failure);
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
