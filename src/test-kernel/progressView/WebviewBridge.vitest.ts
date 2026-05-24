// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - common webview
import { StreamLogStore, type StreamLogAppendInput } from '@transcript';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';


// Local imports - progress view
import { WebviewBridge } from '@progressView/managers/WebviewBridge';

// Local imports - shared schemas
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamTabId,
} from '@shared/schemas';

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

describe('WebviewBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes active stream log deltas', async () => {
    vi.useFakeTimers();
    const store = new StreamLogStore();
    const activeStream = 'active' as StreamTabId;
    const postMessage = vi.fn();
    const bridge = new WebviewBridge(
      store,
      () => [{ postMessage } as never],
      () => activeStream,
    );

    store.append(activeStream, logEntry('active-1', 'active log', 100));
    await vi.advanceTimersByTimeAsync(20);

    expect(postMessage).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries: [
        expect.objectContaining({
          id: 'active-1',
          text: 'active log',
        }),
      ],
      updates: [],
    });

    bridge.dispose();
  });

  it('does not queue inactive stream flushes that race with tab switches', async () => {
    vi.useFakeTimers();
    const store = new StreamLogStore();
    let activeStream = 'active' as StreamTabId;
    const postMessage = vi.fn();
    const bridge = new WebviewBridge(
      store,
      () => [{ postMessage } as never],
      () => activeStream,
    );

    store.append(
      'inactive' as StreamTabId,
      logEntry('inactive-1', 'inactive log', 100),
    );
    activeStream = 'inactive' as StreamTabId;
    await vi.advanceTimersByTimeAsync(20);

    expect(postMessage).not.toHaveBeenCalled();

    bridge.dispose();
  });

  it('syncs inactive stream history explicitly on tab switch', async () => {
    vi.useFakeTimers();
    const store = new StreamLogStore();
    let activeStream = 'active' as StreamTabId;
    const postMessage = vi.fn();
    const bridge = new WebviewBridge(
      store,
      () => [{ postMessage } as never],
      () => activeStream,
    );

    store.append(
      'inactive' as StreamTabId,
      logEntry('inactive-1', 'inactive log', 100),
    );

    activeStream = 'inactive' as StreamTabId;
    bridge.syncStream(activeStream);
    await vi.advanceTimersByTimeAsync(20);

    expect(postMessage).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: activeStream,
      entries: [
        expect.objectContaining({
          id: 'inactive-1',
          text: 'inactive log',
        }),
      ],
      updates: [],
    });

    bridge.dispose();
  });
});
