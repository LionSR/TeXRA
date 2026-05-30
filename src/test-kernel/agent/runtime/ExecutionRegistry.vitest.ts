// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import {
  AgentExecutionHandle,
  detachActiveChildren,
  trackExecution,
  untrackExecution,
} from '@agent/runtime/executionRegistry';
import type { StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

describe('executionRegistry', () => {
  it('publishes handle updates through the handle runtime host', () => {
    const explicit = createRecordingHost();
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

      trackExecution(handle);
      untrackExecution(executionId);

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
      untrackExecution(executionId);
    }
  });

  it('publishes detach updates through the caller runtime host', () => {
    const explicit = createRecordingHost();
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

      trackExecution(handle);
      detachActiveChildren(parentStreamId, explicit.host);

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
      untrackExecution(executionId);
    }
  });
});
