// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Regression coverage for subscribeStreamLog's shared createFlushableDebounce
// migration: the "only start the batch window on its first tick" coalescing
// behavior, and dispose() cancelling (not flushing) a still-pending batch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { subscribeStreamLog } from '@cli/chat/tui/state/subscribeStreamLog';
import {
  activeStreamId,
  patchStream,
  resetCliState,
  streams,
} from '@cli/chat/tui/state/cliState';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type StreamTabId,
} from '@shared/schemas';
import type { StreamLogStore } from '@transcript';

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
  beforeEach(async () => {
    // No separate default-store export to swap in anymore (#7694) —
    // `subscribeStreamLog()` reads the default session's own `transcripts`
    // store, so clear it in place instead.
    await defaultSession().transcripts.clear();
    resetCliState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple store changes within the batch window into a single sync pass', () => {
    const dispose = subscribeStreamLog();
    const store = defaultSession().transcripts;

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
    expect(streams.get().get(streamB)).toMatchObject({
      description: 'world',
      entries: [],
    });

    dispose();
  });

  it('dispose cancels a pending batch instead of flushing it', () => {
    const dispose = subscribeStreamLog();
    const store = defaultSession().transcripts;

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
    const store = defaultSession().transcripts;
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

  it('releases a dormant transcript whose focus load finishes late', async () => {
    const store = defaultSession().transcripts;
    appendUserMessage(store, streamA, 'a-1', 'loaded late');
    patchStream(streamA, (slice) => ({
      ...slice,
      status: STREAM_PHASE.WAITING,
    }));

    let finishLoad = (): void => {};
    let loadFinished = false;
    const loadGate = new Promise<void>((resolve) => {
      finishLoad = () => {
        loadFinished = true;
        resolve();
      };
    });
    const originalGet = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation((streamId) =>
      streamId === streamA && !loadFinished ? undefined : originalGet(streamId),
    );
    vi.spyOn(store, 'ensureLoaded').mockImplementation(async (streamId) => {
      if (streamId === streamA) await loadGate;
    });
    const releaseEntries = vi.spyOn(store, 'releaseEntries');
    const dispose = subscribeStreamLog();

    activeStreamId.set(streamA);
    await Promise.resolve();
    activeStreamId.set(streamB);
    await Promise.resolve();
    finishLoad();
    await loadGate;
    await Promise.resolve();

    expect(streams.get().get(streamA)).toMatchObject({
      description: 'loaded late',
      entries: [],
    });
    expect(releaseEntries).toHaveBeenCalledWith(streamA);

    dispose();
  });
});
