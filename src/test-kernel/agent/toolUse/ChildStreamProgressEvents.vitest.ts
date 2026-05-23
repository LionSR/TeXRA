// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  getDefaultAgentRuntimeHost,
  setDefaultAgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import {
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { createChildStream, finalizeChildStream } from '@tools/childStream';
import { createRecordingHost } from '../progressTestUtils';

const executionId = 'exec:child-stream' as ExecutionId;
const parentStreamId = 'stream:parent' as StreamTabId;
const childStreamId = 'bash#exec:child-stream' as StreamTabId;
const config = {
  agentCategory: AgentCategory.ToolUse,
  model: 'test-model',
  agent: 'test-agent',
} as unknown as AgentConfig;

describe('child stream progress events', () => {
  it('publishes child stream lifecycle events through the explicit runtime host', () => {
    const active = createRecordingHost();
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    setDefaultAgentRuntimeHost(fallback.host);

    try {
      const {
        childStreamId: actualChildStreamId,
        logger,
        disposeTrace,
      } = createChildStream(executionId, parentStreamId, {
        runtimeHost: active.host,
        streamPrefix: 'bash',
        streamCategory: AgentCategory.ToolUse,
        agentName: 'test-agent',
        description: 'Run a background bash command',
        config,
        toolName: 'bash',
      });

      expect(actualChildStreamId).toBe(childStreamId);

      finalizeChildStream({
        childStreamId,
        executionId,
        logger,
        disposeTrace,
        runtimeHost: active.host,
        options: { autoClose: true },
      });
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }

    const { events } = active;
    expect(events.map((entry) => entry.event)).toEqual([
      'updateStreamStatus',
      'setActiveStream',
      'setTaskState',
      'updateStreamDescription',
      'updateActiveSubagents',
      'setParentStream',
      'updateStreamStatus',
      'updateActiveSubagents',
      'updateActiveSubagents',
      'removeStream',
    ]);
    expect(events[0]).toEqual({
      event: 'updateStreamStatus',
      payload: {
        streamId: childStreamId,
        status: STREAM_STATUS.RUNNING,
        previousStatus: STREAM_STATUS.READY,
      },
    });
    // Background child streams register without yanking the active tab —
    // suppressViewSwitch: true keeps the user's current view stable.
    expect(events[1]).toEqual({
      event: 'setActiveStream',
      payload: {
        streamId: childStreamId,
        agentCategory: AgentCategory.ToolUse,
        suppressViewSwitch: true,
      },
    });
    expect(events[2]).toEqual({
      event: 'setTaskState',
      payload: {
        streamId: childStreamId,
        executionId,
        taskState: {
          agentConfig: config,
          toolSessionState: {},
        },
      },
    });
    expect(events[4].payload).toEqual({
      parentStreamId,
      children: [
        expect.objectContaining({
          executionId,
          childStreamId,
          agentName: 'test-agent',
          status: STREAM_STATUS.RUNNING,
          toolName: 'bash',
        }),
      ],
    });
    expect(events[6]).toEqual({
      event: 'updateStreamStatus',
      payload: {
        streamId: childStreamId,
        status: STREAM_STATUS.READY,
        previousStatus: STREAM_STATUS.RUNNING,
      },
    });
    expect(events[8]).toEqual({
      event: 'updateActiveSubagents',
      payload: { parentStreamId, children: [] },
    });
    expect(events[9]).toEqual({
      event: 'removeStream',
      payload: { streamId: childStreamId },
    });
    expect(fallback.events).toEqual([]);
  });
});
