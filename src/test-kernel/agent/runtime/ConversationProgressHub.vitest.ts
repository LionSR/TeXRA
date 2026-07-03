import { describe, expect, it } from 'vitest';

import { logConversationProgress, TraceEmitter } from '@agent/trace';
import { attachConversationProgressHub } from '@agent/runtime/conversationProgressHub';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type { StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

function attachTraceToHub(
  trace: TraceEmitter,
  hub: SessionEventHub,
  streamId: StreamTabId,
): () => void {
  return trace.subscribe((event) =>
    hub.emit({ scope: 'run', streamId, event }),
  );
}

describe('attachConversationProgressHub (F-1b)', () => {
  it('derives updateConversationProgress from a conversationProgress domain event', () => {
    const trace = new TraceEmitter();
    const hub = new SessionEventHub();
    const { events, host } = createRecordingHost();
    const streamId = 'stream:hub-test' as StreamTabId;
    const detachTrace = attachTraceToHub(trace, hub, streamId);
    const detach = attachConversationProgressHub(hub, host, streamId);

    try {
      logConversationProgress(trace, {
        conversationTurns: 2,
        toolCallCount: 5,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        event: 'updateConversationProgress',
        payload: {
          streamId,
          progress: { conversationTurns: 2, toolCallCount: 5 },
        },
      });
    } finally {
      detach();
      detachTrace();
    }
  });

  it('ignores unrelated domain events and stops forwarding after detach', () => {
    const trace = new TraceEmitter();
    const hub = new SessionEventHub();
    const { events, host } = createRecordingHost();
    const streamId = 'stream:hub-test-2' as StreamTabId;
    const detachTrace = attachTraceToHub(trace, hub, streamId);
    const detach = attachConversationProgressHub(hub, host, streamId);

    trace.domain({ key: 'webSearch', data: { query: 'irrelevant' } });
    expect(events).toHaveLength(0);

    detach();
    logConversationProgress(trace, { conversationTurns: 1, toolCallCount: 0 });
    expect(events).toHaveLength(0);
    detachTrace();
  });

  it('drops a conversationProgress event with missing or malformed data instead of forwarding it', () => {
    const trace = new TraceEmitter();
    const hub = new SessionEventHub();
    const { events, host } = createRecordingHost();
    const streamId = 'stream:hub-test-3' as StreamTabId;
    const detachTrace = attachTraceToHub(trace, hub, streamId);
    const detach = attachConversationProgressHub(hub, host, streamId);

    try {
      trace.domain({ key: 'conversationProgress', data: undefined });
      trace.domain({
        key: 'conversationProgress',
        data: { conversationTurns: 1 },
      });
      trace.domain({ key: 'conversationProgress', data: 'not an object' });

      expect(events).toHaveLength(0);
    } finally {
      detach();
      detachTrace();
    }
  });
});
