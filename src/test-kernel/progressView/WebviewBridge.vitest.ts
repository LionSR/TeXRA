// Third-party imports
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

// Local imports
import {
  WebviewBridge,
  type ProgressViewMessageSender,
} from '@controllers/progressView/backend/WebviewBridge';
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
  withTranscriptWriter,
} from '@test/support/storeTestDrivers';
import { StreamLogStore, type StreamLogAppendInput } from '@transcript';

const ACTIVE = 'active' as StreamTabId;
const INACTIVE = 'inactive' as StreamTabId;

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

/** The exact LOG_DELTA payload shape the bridge posts to the webview. */
function logDeltaMessage(
  streamId: StreamTabId,
  delta: {
    entries?: unknown[];
    updates?: unknown[];
    textDeltas?: unknown[];
  },
): Record<string, unknown> {
  return {
    command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
    streamId,
    entries: delta.entries ?? [],
    updates: delta.updates ?? [],
    textDeltas: delta.textDeltas ?? [],
  };
}

function entryContaining(id: string, text: string): unknown {
  return expect.objectContaining({ id, text });
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

  /** Builds a bridge wired to an ephemeral store and registered for teardown. */
  function setupBridge(
    options: {
      sendMessage?: Mock<ProgressViewMessageSender>;
      activeStream?: () => StreamTabId;
    } = {},
  ): {
    store: StreamLogStore;
    sendMessage: Mock<ProgressViewMessageSender>;
    bridge: WebviewBridge;
  } {
    const store = StreamLogStore.ephemeral('test');
    const sendMessage =
      options.sendMessage ?? vi.fn<ProgressViewMessageSender>(() => true);
    const bridge = new WebviewBridge(
      store,
      sendMessage,
      options.activeStream ?? (() => ACTIVE),
    );
    bridges.push(bridge);
    return { store, sendMessage, bridge };
  }

  it('flushes active stream log deltas', async () => {
    const { store, sendMessage, bridge } = setupBridge();

    bridge.syncStream(ACTIVE);
    appendTranscriptEntry(
      store,
      ACTIVE,
      logEntry('active-1', 'active log', 100),
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledWith(
      logDeltaMessage(ACTIVE, {
        entries: [entryContaining('active-1', 'active log')],
      }),
    );
  });

  it('pushes restart-repair group settlements through log deltas', async () => {
    const repairStream = 'active-repair' as StreamTabId;
    const { store, sendMessage, bridge } = setupBridge({
      activeStream: () => repairStream,
    });

    appendTranscriptEntry(store, repairStream, {
      id: 'running-group',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      data: { status: STREAM_PHASE.RUNNING },
    });
    bridge.syncStream(repairStream);
    await vi.advanceTimersByTimeAsync(20);
    sendMessage.mockClear();

    await store.endRunningGroupsForStreams(
      [repairStream],
      200,
      RUN_OUTCOME.FAILED,
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledWith(
      logDeltaMessage(repairStream, {
        updates: [
          expect.objectContaining({
            id: 'running-group',
            type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
            data: expect.objectContaining({ status: RUN_OUTCOME.FAILED }),
          }),
        ],
      }),
    );
  });

  it('does not queue inactive stream flushes that race with tab switches', async () => {
    let activeStream = ACTIVE;
    const { store, sendMessage } = setupBridge({
      activeStream: () => activeStream,
    });

    appendTranscriptEntry(
      store,
      INACTIVE,
      logEntry('inactive-1', 'inactive log', 100),
    );
    activeStream = INACTIVE;
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('syncs inactive stream history explicitly on tab switch', async () => {
    let activeStream = ACTIVE;
    const { store, sendMessage, bridge } = setupBridge({
      activeStream: () => activeStream,
    });

    appendTranscriptEntry(
      store,
      INACTIVE,
      logEntry('inactive-1', 'inactive log', 100),
    );

    activeStream = INACTIVE;
    bridge.syncStream(activeStream);
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledWith(
      logDeltaMessage(INACTIVE, {
        entries: [entryContaining('inactive-1', 'inactive log')],
      }),
    );
  });

  it('replays full streamed text when a webview syncs mid-stream', async () => {
    const { store, sendMessage, bridge } = setupBridge();

    appendTranscriptEntry(store, ACTIVE, logEntry('active-1', '', 100));
    appendTranscriptText(store, ACTIVE, 'active-1', 'hello ');
    appendTranscriptText(store, ACTIVE, 'active-1', 'world');

    bridge.syncStream(ACTIVE);
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledWith(
      logDeltaMessage(ACTIVE, {
        entries: [entryContaining('active-1', 'hello world')],
      }),
    );
  });

  it('resyncs from scratch when no target accepts a log delta', async () => {
    const { store, sendMessage, bridge } = setupBridge({
      sendMessage: vi
        .fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
    });

    bridge.syncStream(ACTIVE);
    appendTranscriptEntry(
      store,
      ACTIVE,
      logEntry('active-1', 'active log', 100),
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);

    updateTranscriptEntry(store, ACTIVE, 'active-1', {
      text: 'edited log',
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(2);

    // The rejected frame is gone — nothing store-side retains it. The next
    // flush must replay the whole log through the oracle path so the
    // disposed-and-restored webview cannot stay stale.
    appendTranscriptEntry(
      store,
      ACTIVE,
      logEntry('active-2', 'retry trigger', 200),
    );
    await vi.advanceTimersByTimeAsync(20);

    // The rejected frame's changes come back via a full replay — the same
    // path used at registration — rather than a redelivery window.
    expect(sendMessage).toHaveBeenLastCalledWith(
      logDeltaMessage(ACTIVE, {
        entries: [
          entryContaining('active-1', 'edited log'),
          entryContaining('active-2', 'retry trigger'),
        ],
      }),
    );
  });

  it('re-registers and replays from scratch on a mid-stream reconnect', async () => {
    const { store, sendMessage, bridge } = setupBridge();

    bridge.syncStream(ACTIVE);
    appendTranscriptEntry(store, ACTIVE, logEntry('active-1', '', 100));
    appendTranscriptText(store, ACTIVE, 'active-1', 'hello');
    await vi.advanceTimersByTimeAsync(20);
    sendMessage.mockClear();

    // Webview disposed and restored: the provider re-runs the registration
    // handshake, which must resync instead of resuming the chunk feed.
    bridge.syncStream(ACTIVE);
    appendTranscriptText(store, ACTIVE, 'active-1', ' world');
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith(
      logDeltaMessage(ACTIVE, {
        entries: [entryContaining('active-1', 'hello world')],
      }),
    );
  });

  it('delivers a stream lifecycle as append, chunk, and settle frames', async () => {
    const { store, sendMessage, bridge } = setupBridge();

    bridge.syncStream(ACTIVE);
    await vi.advanceTimersByTimeAsync(20);
    expect(sendMessage).not.toHaveBeenCalled();

    appendTranscriptEntry(store, ACTIVE, logEntry('m1', '', 100));
    await vi.advanceTimersByTimeAsync(20);
    appendTranscriptText(store, ACTIVE, 'm1', 'hel');
    appendTranscriptText(store, ACTIVE, 'm1', 'lo');
    await vi.advanceTimersByTimeAsync(20);
    withTranscriptWriter(store, ACTIVE, (writer) =>
      writer.settle('m1', { text: 'hello!' }),
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      logDeltaMessage(ACTIVE, { entries: [entryContaining('m1', '')] }),
      logDeltaMessage(ACTIVE, {
        textDeltas: [{ id: 'm1', appendText: 'hello' }],
      }),
      logDeltaMessage(ACTIVE, { updates: [entryContaining('m1', 'hello!')] }),
    ]);
  });

  it('serializes async flushes and preserves updates made during delivery', async () => {
    const firstDelivery = deferredBoolean();
    const { store, sendMessage, bridge } = setupBridge({
      sendMessage: vi
        .fn()
        .mockReturnValueOnce(firstDelivery.promise)
        .mockResolvedValue(true),
    });

    bridge.syncStream(ACTIVE);
    appendTranscriptEntry(
      store,
      ACTIVE,
      logEntry('active-1', 'active log', 100),
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);

    updateTranscriptEntry(store, ACTIVE, 'active-1', {
      text: 'edited while sending',
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);

    firstDelivery.resolve(true);
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(
      logDeltaMessage(ACTIVE, {
        updates: [entryContaining('active-1', 'edited while sending')],
      }),
    );
  });

  it('does not resend streamed text already covered by an in-flight full entry', async () => {
    const firstDelivery = deferredBoolean();
    const { store, sendMessage, bridge } = setupBridge({
      sendMessage: vi
        .fn()
        .mockReturnValueOnce(firstDelivery.promise)
        .mockResolvedValue(true),
    });

    bridge.syncStream(ACTIVE);
    appendTranscriptEntry(store, ACTIVE, logEntry('active-1', '', 100));
    appendTranscriptText(store, ACTIVE, 'active-1', 'hello');
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenLastCalledWith(
      logDeltaMessage(ACTIVE, {
        entries: [entryContaining('active-1', 'hello')],
      }),
    );

    appendTranscriptText(store, ACTIVE, 'active-1', ' world');
    await vi.advanceTimersByTimeAsync(20);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    firstDelivery.resolve(true);
    await vi.advanceTimersByTimeAsync(20);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(
      logDeltaMessage(ACTIVE, {
        textDeltas: [{ id: 'active-1', appendText: ' world' }],
      }),
    );
  });

  it('ships streamed text as O(L) append deltas instead of full updates', async () => {
    let deliveredBytes = 0;
    const { store, sendMessage, bridge } = setupBridge({
      sendMessage: vi.fn((message) => {
        deliveredBytes += JSON.stringify(message).length;
        return true;
      }),
    });
    const chunk = 'x'.repeat(1024);

    bridge.syncStream(ACTIVE);
    appendTranscriptEntry(store, ACTIVE, logEntry('active-1', '', 100));
    await vi.advanceTimersByTimeAsync(20);

    for (let i = 0; i < 40; i++) {
      appendTranscriptText(store, ACTIVE, 'active-1', chunk);
      await vi.advanceTimersByTimeAsync(20);
    }

    const streamedFrames = sendMessage.mock.calls.slice(1).map(([message]) => {
      expect(message).toEqual(
        expect.objectContaining(
          logDeltaMessage(ACTIVE, {
            textDeltas: [{ id: 'active-1', appendText: chunk }],
          }),
        ),
      );
      return JSON.stringify(message).length;
    });

    expect(streamedFrames).toHaveLength(40);
    expect(deliveredBytes).toBeLessThan(90_000);
  });
});
