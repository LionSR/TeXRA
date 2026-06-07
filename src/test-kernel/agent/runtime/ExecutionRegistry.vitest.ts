// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  AgentExecutionHandle,
  ExecutionRegistry,
} from '@agent/runtime/executionRegistry';
import { StreamStatusRegistry } from '@agent/runtime/StreamStatusService';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

describe('executionRegistry', () => {
  it('publishes handle updates through the handle runtime host', () => {
    const explicit = createRecordingHost();
    const registry = new ExecutionRegistry();
    const executionId = 'exec-handle-runtime-host-test';
    const parentStreamId = 'parent-handle-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-handle-runtime-host-test' as StreamTabId;

    try {
      const handle = new AgentExecutionHandle(
        executionId,
        parentStreamId,
        childStreamId,
        'test-subagent',
        'toolUse',
        explicit.host,
      );

      registry.track(handle);
      registry.untrack(executionId);

      expect(explicit.events.map((entry) => entry.event)).toEqual([
        'updateActiveSubagents',
        'setParentStream',
        'updateActiveSubagents',
      ]);
      expect(explicit.events[0].payload).toMatchObject({
        parentStreamId,
        children: [
          {
            executionId,
            agentName: 'test-subagent',
            childStreamId,
          },
        ],
      });
      expect(explicit.events[2].payload).toEqual({
        parentStreamId,
        children: [],
      });
    } finally {
      registry.dispose();
    }
  });

  it('publishes detach updates through the caller runtime host', () => {
    const explicit = createRecordingHost();
    const registry = new ExecutionRegistry();
    const executionId = 'exec-detach-runtime-host-test';
    const parentStreamId = 'parent-detach-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-detach-runtime-host-test' as StreamTabId;

    try {
      const handle = new AgentExecutionHandle(
        executionId,
        parentStreamId,
        childStreamId,
        'test-subagent',
        'toolUse',
        explicit.host,
      );

      registry.track(handle);
      registry.detachActiveChildren(parentStreamId, explicit.host);

      expect(explicit.events.map((entry) => entry.event)).toEqual([
        'updateActiveSubagents',
        'setParentStream',
        'setParentStream',
        'updateActiveSubagents',
      ]);
      expect(explicit.events[2].payload).toEqual({
        childStreamId,
        parentStreamId: null,
      });
      expect(explicit.events[3].payload).toEqual({
        parentStreamId,
        children: [],
      });
    } finally {
      registry.dispose();
    }
  });

  it('detaches its stream-status listener when disposed', () => {
    const explicit = createRecordingHost();
    const streamStatus = new StreamStatusRegistry();
    const registry = new ExecutionRegistry({ streamStatus });
    const executionId = 'exec-dispose-runtime-host-test';
    const parentStreamId = 'parent-dispose-runtime-host-test' as StreamTabId;
    const childStreamId = 'child-dispose-runtime-host-test' as StreamTabId;

    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'test-subagent',
      'toolUse',
      explicit.host,
    );

    registry.track(handle);
    registry.dispose();
    explicit.events.length = 0;

    streamStatus.set(childStreamId, STREAM_STATUS.WAITING, {
      runtimeHost: explicit.host,
    });

    expect(
      explicit.events.some((entry) => entry.event === 'updateActiveSubagents'),
    ).toBe(false);
  });
});
