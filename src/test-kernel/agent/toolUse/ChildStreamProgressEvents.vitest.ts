// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { createChildStream } from '@tools/childStream';
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

    const childStream = createChildStream(executionId, parentStreamId, {
      runtimeHost: active.host,
      streamPrefix: 'bash',
      streamCategory: AgentCategory.ToolUse,
      agentName: 'test-agent',
      description: 'Run a background bash command',
      config,
      toolName: 'bash',
    });

    expect(childStream.childStreamId).toBe(childStreamId);

    childStream.finalize({ autoClose: true });

    const { events } = active;
    expect(events.map((entry) => entry.event)).toEqual([
      'setActiveStream',
      'setTaskState',
      'updateStreamDescription',
      'updateStreamStatus',
      'updateActiveSubagents',
      'setParentStream',
      'updateStreamStatus',
      'updateActiveSubagents',
      'updateActiveSubagents',
      'removeStream',
    ]);
    // Background child streams register without yanking the active tab —
    // suppressViewSwitch: true keeps the user's current view stable.
    expect(events[0]).toEqual({
      event: 'setActiveStream',
      payload: {
        streamId: childStreamId,
        agentCategory: AgentCategory.ToolUse,
        suppressViewSwitch: true,
      },
    });
    expect(events[1]).toEqual({
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
    expect(events[3]).toEqual({
      event: 'updateStreamStatus',
      payload: {
        streamId: childStreamId,
        status: STREAM_STATUS.RUNNING,
        previousStatus: STREAM_STATUS.READY,
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
  });
});
