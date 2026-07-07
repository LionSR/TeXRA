import { describe, expect, it } from 'vitest';

import { logConversationProgress, TraceEmitter } from '@agent/trace';
import { attachSessionProgressEventProjection } from '@agent/runtime/sessionProgressEventProjection';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type { StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

function setupHub(streamId: StreamTabId) {
  const trace = new TraceEmitter();
  const hub = new SessionEventHub();
  const { events, host } = createRecordingHost();
  const detachTrace = trace.subscribe((event) =>
    hub.emit({ scope: 'run', streamId, event }),
  );
  const detach = attachSessionProgressEventProjection(hub, host);
  return {
    trace,
    events,
    detachAll: () => {
      detach();
      detachTrace();
    },
  };
}

describe('conversationProgress session projection', () => {
  it('derives updateConversationProgress from a conversationProgress domain event', () => {
    const streamId = 'stream:hub-test' as StreamTabId;
    const { trace, events, detachAll } = setupHub(streamId);

    try {
      logConversationProgress(trace, {
        toolCallCount: 5,
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        event: 'updateConversationProgress',
        payload: {
          streamId,
          progress: { toolCallCount: 5 },
        },
      });
    } finally {
      detachAll();
    }
  });

  it('ignores unrelated domain events and stops forwarding after detach', () => {
    const streamId = 'stream:hub-test-2' as StreamTabId;
    const { trace, events, detachAll } = setupHub(streamId);

    trace.domain({ key: 'webSearch', data: { query: 'irrelevant' } });
    expect(events).toHaveLength(0);

    detachAll();
    logConversationProgress(trace, { toolCallCount: 0 });
    expect(events).toHaveLength(0);
  });

  it('drops a conversationProgress event with missing or malformed data instead of forwarding it', () => {
    const streamId = 'stream:hub-test-3' as StreamTabId;
    const { trace, events, detachAll } = setupHub(streamId);

    try {
      trace.domain({ key: 'conversationProgress', data: undefined });
      trace.domain({
        key: 'conversationProgress',
        data: { toolCallCount: '1' },
      });
      trace.domain({ key: 'conversationProgress', data: 'not an object' });

      expect(events).toHaveLength(0);
    } finally {
      detachAll();
    }
  });
});
