// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type StreamTabId,
} from '@shared/schemas';
import {
  appendTranscriptEntry,
  appendTranscriptText,
  updateTranscriptEntry,
} from '@test/support/storeTestDrivers';
import { StreamLogStore, type StreamLogAppendInput } from '@transcript';

function logEntry(
  id: string,
  text: string,
  timestamp: number,
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

function deferredBoolean(): {
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
} {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('WebviewBridge', () => {
  const bridges: WebviewBridge[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.dispose();
    vi.useRealTimers();
  });

  /** Registers a bridge for the shared teardown above. */
  function track(bridge: WebviewBridge): WebviewBridge {
    bridges.push(bridge);
    return bridge;
  }

  it('flushes active stream log deltas', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    const sendMessage = vi.fn(() => true);
    const bridge = track(
      new WebviewBridge(store, sendMessage, () => activeStream),
    );

    bridge.syncStream(activeStream);
    appendTranscriptEntry(
      store,
      activeStream,
      logEntry('active-1', 'active log', 100),
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries: [
        expect.objectContaining({
          id: 'active-1',
          text: 'active log',
        }),
      ],
      updates: [],
      textDeltas: [],
    });
  });

  it('pushes restart-repair group settlements through log deltas', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active-repair' as StreamTabId;
    const sendMessage = vi.fn(() => true);
    const bridge = track(
      new WebviewBridge(store, sendMessage, () => activeStream),
    );

    appendTranscriptEntry(store, activeStream, {
      id: 'running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      data: { status: STREAM_PHASE.RUNNING },
    });
    bridge.syncStream(activeStream);
    await vi.advanceTimersByTimeAsync(20);
    sendMessage.mockClear();

    await store.endRunningGroupsForStreams(
      [activeStream],
      200,
      RUN_OUTCOME.FAILED,
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries: [],
      updates: [
        expect.objectContaining({
          id: 'running-group',
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          data: expect.objectContaining({ status: RUN_OUTCOME.FAILED }),
        }),
      ],
      textDeltas: [],
    });
  });

  it('does not queue inactive stream flushes that race with tab switches', async () => {
    const store = StreamLogStore.ephemeral('test');
    let activeStream = 'active' as StreamTabId;
    const sendMessage = vi.fn(() => true);
    const bridge = track(
      new WebviewBridge(store, sendMessage, () => activeStream),
    );

    appendTranscriptEntry(
      store,
      'inactive' as StreamTabId,
      logEntry('inactive-1', 'inactive log', 100),
    );
    activeStream = 'inactive' as StreamTabId;
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('syncs inactive stream history explicitly on tab switch', async () => {
    const store = StreamLogStore.ephemeral('test');
    let activeStream = 'active' as StreamTabId;
    const sendMessage = vi.fn(() => true);
    const bridge = track(
      new WebviewBridge(store, sendMessage, () => activeStream),
    );

    appendTranscriptEntry(
      store,
      'inactive' as StreamTabId,
      logEntry('inactive-1', 'inactive log', 100),
    );

    activeStream = 'inactive' as StreamTabId;
    bridge.syncStream(activeStream);
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries: [
        expect.objectContaining({
          id: 'inactive-1',
          text: 'inactive log',
        }),
      ],
      updates: [],
      textDeltas: [],
    });
  });

  it('replays full streamed text when a webview syncs mid-stream', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    const sendMessage = vi.fn(() => true);
    const bridge = track(
      new WebviewBridge(store, sendMessage, () => activeStream),
    );

    appendTranscriptEntry(store, activeStream, logEntry('active-1', '', 100));
    appendTranscriptText(store, activeStream, 'active-1', 'hello ');
    appendTranscriptText(store, activeStream, 'active-1', 'world');

    bridge.syncStream(activeStream);
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries: [
        expect.objectContaining({
          id: 'active-1',
          text: 'hello world',
        }),
      ],
      updates: [],
      textDeltas: [],
    });
  });

  it('keeps the cursor and dirty updates when no target accepts a log delta', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const bridge = track(
      new WebviewBridge(store, sendMessage, () => activeStream),
    );

    bridge.syncStream(activeStream);
    appendTranscriptEntry(
      store,
      activeStream,
      logEntry('active-1', 'active log', 100),
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);

    updateTranscriptEntry(store, activeStream, 'active-1', {
      text: 'edited log',
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(2);

    appendTranscriptEntry(
      store,
      activeStream,
      logEntry('active-2', 'retry trigger', 200),
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenLastCalledWith({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries: [
        expect.objectContaining({
          id: 'active-2',
          text: 'retry trigger',
        }),
      ],
      updates: [
        expect.objectContaining({
          id: 'active-1',
          text: 'edited log',
        }),
      ],
      textDeltas: [],
    });
  });

  it('serializes async flushes and preserves updates made during delivery', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    const firstDelivery = deferredBoolean();
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(firstDelivery.promise)
      .mockResolvedValue(true);
    const bridge = track(
      new WebviewBridge(store, sendMessage, () => activeStream),
    );

    bridge.syncStream(activeStream);
    appendTranscriptEntry(
      store,
      activeStream,
      logEntry('active-1', 'active log', 100),
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);

    updateTranscriptEntry(store, activeStream, 'active-1', {
      text: 'edited while sending',
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);

    firstDelivery.resolve(true);
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries: [],
      updates: [
        expect.objectContaining({
          id: 'active-1',
          text: 'edited while sending',
        }),
      ],
      textDeltas: [],
    });
  });

  it('does not resend streamed text already covered by an in-flight full entry', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    const firstDelivery = deferredBoolean();
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(firstDelivery.promise)
      .mockResolvedValue(true);
    const bridge = track(
      new WebviewBridge(store, sendMessage, () => activeStream),
    );

    bridge.syncStream(activeStream);
    appendTranscriptEntry(store, activeStream, logEntry('active-1', '', 100));
    appendTranscriptText(store, activeStream, 'active-1', 'hello');
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries: [
        expect.objectContaining({
          id: 'active-1',
          text: 'hello',
        }),
      ],
      updates: [],
      textDeltas: [],
    });

    appendTranscriptText(store, activeStream, 'active-1', ' world');
    await vi.advanceTimersByTimeAsync(20);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    firstDelivery.resolve(true);
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries: [],
      updates: [],
      textDeltas: [{ id: 'active-1', appendText: ' world' }],
    });
  });

  it('ships streamed text as O(L) append deltas instead of full updates', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    let deliveredBytes = 0;
    const sendMessage = vi.fn((message) => {
      deliveredBytes += JSON.stringify(message).length;
      return true;
    });
    const bridge = track(
      new WebviewBridge(store, sendMessage, () => activeStream),
    );
    const chunk = 'x'.repeat(1024);

    bridge.syncStream(activeStream);
    appendTranscriptEntry(store, activeStream, logEntry('active-1', '', 100));
    await vi.advanceTimersByTimeAsync(20);

    for (let i = 0; i < 40; i++) {
      appendTranscriptText(store, activeStream, 'active-1', chunk);
      await vi.advanceTimersByTimeAsync(20);
    }

    const streamedFrames = sendMessage.mock.calls.slice(1).map(([message]) => {
      expect(message).toEqual(
        expect.objectContaining({
          entries: [],
          updates: [],
          textDeltas: [{ id: 'active-1', appendText: chunk }],
        }),
      );
      return JSON.stringify(message).length;
    });

    expect(streamedFrames).toHaveLength(40);
    expect(deliveredBytes).toBeLessThan(90_000);
  });
});
