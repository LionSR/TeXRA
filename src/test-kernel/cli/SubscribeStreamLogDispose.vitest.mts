// Regression coverage for subscribeStreamLog's shared createFlushableDebounce
// migration: the "only start the batch window on its first tick" coalescing
// behavior, and dispose() cancelling (not flushing) a still-pending batch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import { subscribeStreamLog } from '@cli/chat/tui/state/subscribeStreamLog';
import { streams } from '@cli/chat/tui/state/cliState/streamsSlice';
import { resetCliState } from '@cli/chat/tui/state/cliState/reset';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamTabId,
} from '@shared/schemas';

const streamA = 'stream-a' as StreamTabId;
const streamB = 'stream-b' as StreamTabId;

function appendUserMessage(
  store: StreamLogStore,
  streamId: StreamTabId,
  id: string,
  text: string,
): void {
  store.append(streamId, {
    id,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: Date.now(),
    messageType: MESSAGE_TYPES.USER_MESSAGE,
    text,
  });
}

describe('subscribeStreamLog batching and dispose', () => {
  let previousStore: StreamLogStore;

  beforeEach(() => {
    previousStore = getDefaultStreamLogStore();
    setDefaultStreamLogStore(new StreamLogStore());
    resetCliState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setDefaultStreamLogStore(previousStore);
  });

  it('coalesces multiple store changes within the batch window into a single sync pass', () => {
    const dispose = subscribeStreamLog();
    const store = getDefaultStreamLogStore();

    appendUserMessage(store, streamA, 'a-1', 'hello');
    // A second change arriving inside the window must NOT restart the timer:
    // if it did, the deadline would move to 5+16=21ms and the assertion
    // below (at the *original* 16ms deadline) would see nothing synced yet.
    vi.advanceTimersByTime(5);
    appendUserMessage(store, streamB, 'b-1', 'world');
    vi.advanceTimersByTime(11);

    expect(
      streams
        .get()
        .get(streamA)
        ?.entries.map((e) => e.text),
    ).toEqual(['hello']);
    expect(
      streams
        .get()
        .get(streamB)
        ?.entries.map((e) => e.text),
    ).toEqual(['world']);

    dispose();
  });

  it('dispose cancels a pending batch instead of flushing it', () => {
    const dispose = subscribeStreamLog();
    const store = getDefaultStreamLogStore();

    appendUserMessage(store, streamA, 'a-1', 'hello');
    // Dispose before the batch window elapses: the pending sync must be
    // dropped, not run early — the entry never reaches the transcript slice.
    dispose();
    vi.advanceTimersByTime(1000);

    expect(streams.get().get(streamA)).toBeUndefined();
  });

  it('a later subscribeStreamLog call still batches normally after a prior dispose', () => {
    const firstDispose = subscribeStreamLog();
    firstDispose();

    const secondDispose = subscribeStreamLog();
    const store = getDefaultStreamLogStore();
    appendUserMessage(store, streamA, 'a-1', 'hello again');
    vi.advanceTimersByTime(16);

    expect(
      streams
        .get()
        .get(streamA)
        ?.entries.map((e) => e.text),
    ).toEqual(['hello again']);

    secondDispose();
  });
});
