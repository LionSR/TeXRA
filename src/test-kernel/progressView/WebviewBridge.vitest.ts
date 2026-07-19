// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { WebviewBridge } from '@controllers/progressView/backend/WebviewBridge';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamTabId,
} from '@shared/schemas';
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
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes active stream log deltas', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    const sendMessage = vi.fn(() => true);
    const bridge = new WebviewBridge(store, sendMessage, () => activeStream);

    bridge.syncStream(activeStream);
    store.append(activeStream, logEntry('active-1', 'active log', 100));
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

    bridge.dispose();
  });

  it('does not queue inactive stream flushes that race with tab switches', async () => {
    const store = StreamLogStore.ephemeral('test');
    let activeStream = 'active' as StreamTabId;
    const sendMessage = vi.fn(() => true);
    const bridge = new WebviewBridge(store, sendMessage, () => activeStream);

    store.append(
      'inactive' as StreamTabId,
      logEntry('inactive-1', 'inactive log', 100),
    );
    activeStream = 'inactive' as StreamTabId;
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it('syncs inactive stream history explicitly on tab switch', async () => {
    const store = StreamLogStore.ephemeral('test');
    let activeStream = 'active' as StreamTabId;
    const sendMessage = vi.fn(() => true);
    const bridge = new WebviewBridge(store, sendMessage, () => activeStream);

    store.append(
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

    bridge.dispose();
  });

  it('replays full streamed text when a webview syncs mid-stream', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    const sendMessage = vi.fn(() => true);
    const bridge = new WebviewBridge(store, sendMessage, () => activeStream);

    store.append(activeStream, logEntry('active-1', '', 100));
    store.appendText(activeStream, 'active-1', 'hello ');
    store.appendText(activeStream, 'active-1', 'world');

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

    bridge.dispose();
  });

  it('keeps the cursor and dirty updates when no target accepts a log delta', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const bridge = new WebviewBridge(store, sendMessage, () => activeStream);

    bridge.syncStream(activeStream);
    store.append(activeStream, logEntry('active-1', 'active log', 100));
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);

    store.update(activeStream, 'active-1', { text: 'edited log' });
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(2);

    store.append(activeStream, logEntry('active-2', 'retry trigger', 200));
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

    bridge.dispose();
  });

  it('serializes async flushes and preserves updates made during delivery', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    const firstDelivery = deferredBoolean();
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(firstDelivery.promise)
      .mockResolvedValue(true);
    const bridge = new WebviewBridge(store, sendMessage, () => activeStream);

    bridge.syncStream(activeStream);
    store.append(activeStream, logEntry('active-1', 'active log', 100));
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);

    store.update(activeStream, 'active-1', { text: 'edited while sending' });
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

    bridge.dispose();
  });

  it('does not resend streamed text already covered by an in-flight full entry', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    const firstDelivery = deferredBoolean();
    const sendMessage = vi
      .fn()
      .mockReturnValueOnce(firstDelivery.promise)
      .mockResolvedValue(true);
    const bridge = new WebviewBridge(store, sendMessage, () => activeStream);

    bridge.syncStream(activeStream);
    store.append(activeStream, logEntry('active-1', '', 100));
    store.appendText(activeStream, 'active-1', 'hello');
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

    store.appendText(activeStream, 'active-1', ' world');
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

    bridge.dispose();
  });

  it('ships streamed text as O(L) append deltas instead of full updates', async () => {
    const store = StreamLogStore.ephemeral('test');
    const activeStream = 'active' as StreamTabId;
    let deliveredBytes = 0;
    const sendMessage = vi.fn((message) => {
      deliveredBytes += JSON.stringify(message).length;
      return true;
    });
    const bridge = new WebviewBridge(store, sendMessage, () => activeStream);
    const chunk = 'x'.repeat(1024);

    bridge.syncStream(activeStream);
    store.append(activeStream, logEntry('active-1', '', 100));
    await vi.advanceTimersByTimeAsync(20);

    for (let i = 0; i < 40; i++) {
      store.appendText(activeStream, 'active-1', chunk);
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

    bridge.dispose();
  });
});
