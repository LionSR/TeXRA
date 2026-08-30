// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Regression coverage for subscribeStreamLog's shared createFlushableDebounce
// migration: the "only start the batch window on its first tick" coalescing
// behavior, and dispose() cancelling (not flushing) a still-pending batch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { transcriptRowHeadline } from '@cli/chat/tui/panes/transcriptEntries';
import {
  releaseInactiveStreamTranscript,
  subscribeStreamLog,
  syncStreamLog,
} from '@cli/chat/tui/state/subscribeStreamLog';
import {
  activeStreamId,
  resetCliState,
  streamPhaseFor,
  streams,
} from '@cli/chat/tui/state/cliState';
import {
  bindChildStreamState,
  unbindChildStreamState,
} from '@cli/chat/tui/state/childExecutions';
import { SessionState } from '@controllers/session/SessionState';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type StreamTabId,
} from '@shared/schemas';
import { setCliStreamPhase } from '@test/support/cliStreamStatus';
import { appendTranscriptEntry } from '@test/support/storeTestDrivers';
import { clearAllStreamStatusesForTest } from '@test/support/streamStatusTestUtils';
import type { StreamLogStore } from '@transcript';

const streamA = 'stream-a' as StreamTabId;
const streamB = 'stream-b' as StreamTabId;

function streamEntryTexts(streamId: StreamTabId): string[] | undefined {
  return streams
    .get()
    .get(streamId)
    ?.entries.map((row) => transcriptRowHeadline(row));
}

function appendUserMessage(
  store: StreamLogStore,
  streamId: StreamTabId,
  id: string,
  text: string,
): void {
  appendTranscriptEntry(store, streamId, {
    id,
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: Date.now(),
    messageType: MESSAGE_TYPES.USER_MESSAGE,
    text,
  });
}

/** Per-stream projection-state occupancy, for the eviction-path check. */
function streamRenderCacheSizes(): {
  taskGroups: number;
  compaction: number;
  render: number;
} {
  const sizes = { taskGroups: 0, compaction: 0, render: 0 };
  for (const { transcriptFold: fold } of streams.get().values()) {
    if (fold?.taskGroupProjection) sizes.taskGroups += 1;
    if (fold?.compactionProjection) sizes.compaction += 1;
    if (fold?.hydrated) sizes.render += 1;
  }
  return sizes;
}

describe('subscribeStreamLog batching and dispose', () => {
  // Transcript release reads the stream's phase off the session status
  // machine, which reaches the CLI through the bound `SessionState`.
  let sessionState: SessionState;

  beforeEach(async () => {
    // No separate default-store export to swap in anymore (#7694) —
    // `subscribeStreamLog(defaultSession())` reads the default session's own `transcripts`
    // store, so clear it in place instead.
    await defaultSession().transcripts.clear();
    // Twice: the first reset retires the ids this suite reuses across tests,
    // the second starts the lifetime with no retired identity.
    resetCliState();
    resetCliState();
    clearAllStreamStatusesForTest(defaultSession().status);
    sessionState = new SessionState(defaultSession());
    bindChildStreamState(sessionState);
    vi.useFakeTimers();
  });

  afterEach(() => {
    unbindChildStreamState(sessionState);
    vi.useRealTimers();
  });

  it('coalesces multiple store changes within the batch window into a single sync pass', () => {
    const dispose = subscribeStreamLog(defaultSession());
    const store = defaultSession().transcripts;

    appendUserMessage(store, streamA, 'a-1', 'hello');
    // A second change arriving inside the window must NOT restart the timer:
    // if it did, the deadline would move to 5+16=21ms and the assertion
    // below (at the *original* 16ms deadline) would see nothing synced yet.
    vi.advanceTimersByTime(5);
    appendUserMessage(store, streamB, 'b-1', 'world');
    vi.advanceTimersByTime(11);

    expect(streamEntryTexts(streamA)).toEqual(['hello']);
    expect(streams.get().get(streamB)).toMatchObject({
      latestLine: 'world',
      entries: [],
    });

    dispose();
  });

  it('dispose cancels a pending batch instead of flushing it', () => {
    const dispose = subscribeStreamLog(defaultSession());
    const store = defaultSession().transcripts;

    appendUserMessage(store, streamA, 'a-1', 'hello');
    // Dispose before the batch window elapses: the pending sync must be
    // dropped, not run early — the entry never reaches the transcript slice.
    dispose();
    vi.advanceTimersByTime(1000);

    expect(streams.get().get(streamA)).toBeUndefined();
  });

  it('a later subscribeStreamLog call still batches normally after a prior dispose', () => {
    const firstDispose = subscribeStreamLog(defaultSession());
    firstDispose();

    const secondDispose = subscribeStreamLog(defaultSession());
    const store = defaultSession().transcripts;
    appendUserMessage(store, streamA, 'a-1', 'hello again');
    vi.advanceTimersByTime(16);

    expect(streamEntryTexts(streamA)).toEqual(['hello again']);

    secondDispose();
  });

  it('releases a completed transcript whose focus load finishes late', async () => {
    const store = defaultSession().transcripts;
    appendUserMessage(store, streamA, 'a-1', 'loaded late');
    setCliStreamPhase({
      streamId: streamA,
      status: STREAM_PHASE.COMPLETED,
    });

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
    const requestEviction = vi.spyOn(store, 'requestEviction');
    const dispose = subscribeStreamLog(defaultSession());

    activeStreamId.set(streamA);
    await Promise.resolve();
    activeStreamId.set(streamB);
    await Promise.resolve();
    finishLoad();
    await loadGate;
    await Promise.resolve();

    expect(streams.get().get(streamA)).toMatchObject({
      latestLine: 'loaded late',
      entries: [],
    });
    expect(requestEviction).toHaveBeenCalledWith(streamA);

    dispose();
  });

  it('does not release a background transcript before its status is known', () => {
    const store = defaultSession().transcripts;
    appendUserMessage(store, streamB, 'b-1', 'starting');
    activeStreamId.set(streamA);
    const requestEviction = vi.spyOn(store, 'requestEviction');

    syncStreamLog(defaultSession(), streamB);
    releaseInactiveStreamTranscript(defaultSession().transcripts, streamB);

    expect(streams.get().get(streamB)).toMatchObject({
      latestLine: 'starting',
      entries: [],
    });
    expect(streamPhaseFor(streamB)).toBeUndefined();
    expect(requestEviction).not.toHaveBeenCalledWith(streamB);
  });

  it('requests bounded residency for a hidden WAITING transcript', () => {
    const store = defaultSession().transcripts;
    appendUserMessage(store, streamB, 'b-1', 'waiting for retry');
    setCliStreamPhase({
      streamId: streamB,
      status: STREAM_PHASE.WAITING,
    });
    activeStreamId.set(streamA);
    const requestEviction = vi.spyOn(store, 'requestEviction');

    releaseInactiveStreamTranscript(defaultSession().transcripts, streamB);

    expect(requestEviction).toHaveBeenCalledWith(streamB);
  });

  it('never releases the focused stream, nor anything while focus is unset', () => {
    const store = defaultSession().transcripts;
    appendUserMessage(store, streamA, 'a-1', 'done but focused');
    setCliStreamPhase({
      streamId: streamA,
      status: STREAM_PHASE.COMPLETED,
    });
    // `vi.spyOn` on an already-spied method returns the existing spy with
    // its accumulated history from earlier tests — clear it first.
    const requestEviction = vi.spyOn(store, 'requestEviction');
    requestEviction.mockClear();

    // No focused stream: every stream projects the full transcript.
    activeStreamId.set(undefined);
    releaseInactiveStreamTranscript(defaultSession().transcripts, streamA);
    // Focused: the active stream keeps its residency even when terminal.
    activeStreamId.set(streamA);
    releaseInactiveStreamTranscript(defaultSession().transcripts, streamA);

    expect(requestEviction).not.toHaveBeenCalled();
  });

  it('drops per-stream render caches when a completed transcript is released', () => {
    const store = defaultSession().transcripts;
    appendUserMessage(store, streamB, 'b-1', 'hello');
    activeStreamId.set(streamA);

    // This sync is what seeds streamB's per-stream projection state.
    syncStreamLog(defaultSession(), streamB);
    expect(streamRenderCacheSizes()).toEqual({
      taskGroups: 1,
      compaction: 1,
      render: 1,
    });

    // Completed and not focused: the lifecycle release both requests store
    // eviction and must drop the projection state too, or it outlives the
    // store's own retention and keeps the whole transcript reachable
    // indefinitely.
    setCliStreamPhase({
      streamId: streamB,
      status: STREAM_PHASE.COMPLETED,
    });
    releaseInactiveStreamTranscript(defaultSession().transcripts, streamB);

    expect(streamRenderCacheSizes()).toEqual({
      taskGroups: 0,
      compaction: 0,
      render: 0,
    });
  });
});
