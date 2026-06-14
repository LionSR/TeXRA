// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
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
const loopExecutionId = 'exec:child-stream-loop' as ExecutionId;
const loopChildStreamId = 'codex#exec:child-stream-loop' as StreamTabId;
const stoppedExecutionId = 'exec:child-stream-stopped' as ExecutionId;
const stoppedChildStreamId = 'codex#exec:child-stream-stopped' as StreamTabId;
const cancelledExecutionId = 'exec:child-stream-cancelled' as ExecutionId;
const cancelledChildStreamId =
  'codex#exec:child-stream-cancelled' as StreamTabId;
const failedExecutionId = 'exec:child-stream-failed' as ExecutionId;
const failedChildStreamId = 'codex#exec:child-stream-failed' as StreamTabId;
const normalizedErrorExecutionId =
  'exec:child-stream-normalized-error' as ExecutionId;
const normalizedErrorChildStreamId =
  'codex#exec:child-stream-normalized-error' as StreamTabId;
const config = {
  agentCategory: AgentCategory.ToolUse,
  model: 'test-model',
  agent: 'test-agent',
} as unknown as AgentConfig;

describe('child stream progress events', () => {
  afterEach(() => {
    for (const streamId of [
      childStreamId,
      loopChildStreamId,
      stoppedChildStreamId,
      cancelledChildStreamId,
      failedChildStreamId,
      normalizedErrorChildStreamId,
    ]) {
      StreamStatusService.clear(streamId, { emit: false });
    }
  });

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
      'updateActiveSubagents',
      'updateStreamStatus',
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
      event: 'updateActiveSubagents',
      payload: { parentStreamId, children: [] },
    });
    expect(events[7]).toEqual({
      event: 'updateStreamStatus',
      payload: {
        streamId: childStreamId,
        status: STREAM_STATUS.READY,
        previousStatus: STREAM_STATUS.RUNNING,
      },
    });
    expect(events[8]).toEqual({
      event: 'removeStream',
      payload: { streamId: childStreamId },
    });
  });

  it('publishes child loop status changes through the child stream owner', async () => {
    const active = createRecordingHost();

    const childStream = createChildStream(loopExecutionId, parentStreamId, {
      runtimeHost: active.host,
      streamPrefix: 'codex',
      streamCategory: AgentCategory.ToolUse,
      agentName: 'codex',
      description: 'Run a long-lived Codex child loop',
      config,
      toolName: 'codex',
    });
    const handle =
      defaultSession().executions.getAgentHandleByStream(loopChildStreamId);
    expect(handle).toBeDefined();
    active.events.splice(0);

    childStream.waitForInput();
    childStream.beginTurn();
    childStream.failTurn();
    childStream.finalize({ status: STREAM_STATUS.ERROR });

    const statusEvents = active.events.filter(
      (entry) => entry.event === 'updateStreamStatus',
    );
    const statuses = statusEvents.map(
      (entry) => (entry.payload as { status: string }).status,
    );
    expect(statuses).toEqual([
      STREAM_STATUS.WAITING,
      STREAM_STATUS.RUNNING,
      STREAM_STATUS.ERROR,
    ]);
    expect(StreamStatusService.get(loopChildStreamId)).toBe(
      STREAM_STATUS.ERROR,
    );
    expect(active.events.at(-1)).toEqual({
      event: 'updateActiveSubagents',
      payload: { parentStreamId, children: [] },
    });
    await expect(handle?.result).resolves.toMatchObject({
      type: 'result',
      outcome: 'failed',
      error: {
        kind: 'unexpected',
        message: 'Child stream failed',
      },
    });
  });

  it('preserves explicit user stops during child loop status changes', async () => {
    const active = createRecordingHost();

    const childStream = createChildStream(stoppedExecutionId, parentStreamId, {
      runtimeHost: active.host,
      streamPrefix: 'codex',
      streamCategory: AgentCategory.ToolUse,
      agentName: 'codex',
      description: 'Run a stopped Codex child loop',
      config,
      toolName: 'codex',
    });
    const handle =
      defaultSession().executions.getAgentHandleByStream(stoppedChildStreamId);
    expect(handle).toBeDefined();
    StreamStatusService.set(stoppedChildStreamId, STREAM_STATUS.STOPPED, {
      emit: false,
    });
    active.events.splice(0);

    childStream.waitForInput();
    childStream.beginTurn();
    childStream.failTurn();
    childStream.finalize({ status: STREAM_STATUS.ERROR });

    expect(StreamStatusService.get(stoppedChildStreamId)).toBe(
      STREAM_STATUS.STOPPED,
    );
    expect(
      active.events.filter((entry) => entry.event === 'updateStreamStatus'),
    ).toHaveLength(0);
    await expect(handle?.result).resolves.toMatchObject({
      type: 'result',
      outcome: 'cancelled',
      executionId: stoppedExecutionId,
      streamId: stoppedChildStreamId,
    });
  });

  it('settles child handle results as cancelled for stopped finalization', async () => {
    const active = createRecordingHost();

    const childStream = createChildStream(
      cancelledExecutionId,
      parentStreamId,
      {
        runtimeHost: active.host,
        streamPrefix: 'codex',
        streamCategory: AgentCategory.ToolUse,
        agentName: 'codex',
        description: 'Run an interrupted Codex child loop',
        config,
        toolName: 'codex',
      },
    );
    const handle = defaultSession().executions.getAgentHandleByStream(
      cancelledChildStreamId,
    );
    expect(handle).toBeDefined();

    childStream.finalize({ status: STREAM_STATUS.STOPPED });

    await expect(handle?.result).resolves.toMatchObject({
      type: 'result',
      outcome: 'cancelled',
      executionId: cancelledExecutionId,
      streamId: cancelledChildStreamId,
    });
  });

  it('settles failed child handle results with error details', async () => {
    const active = createRecordingHost();

    const childStream = createChildStream(failedExecutionId, parentStreamId, {
      runtimeHost: active.host,
      streamPrefix: 'codex',
      streamCategory: AgentCategory.ToolUse,
      agentName: 'codex',
      description: 'Run a failing Codex child loop',
      config,
      toolName: 'codex',
    });
    const handle =
      defaultSession().executions.getAgentHandleByStream(failedChildStreamId);
    expect(handle).toBeDefined();

    childStream.finalize({ errorMessage: 'child process exited 1' });

    await expect(handle?.result).resolves.toMatchObject({
      type: 'result',
      outcome: 'failed',
      executionId: failedExecutionId,
      streamId: failedChildStreamId,
      error: {
        kind: 'unexpected',
        message: 'child process exited 1',
      },
    });
  });

  it('normalizes explicit non-error status when child finalization has an error', async () => {
    const active = createRecordingHost();

    const childStream = createChildStream(
      normalizedErrorExecutionId,
      parentStreamId,
      {
        runtimeHost: active.host,
        streamPrefix: 'codex',
        streamCategory: AgentCategory.ToolUse,
        agentName: 'codex',
        description: 'Run a child loop with mismatched finalization inputs',
        config,
        toolName: 'codex',
      },
    );
    const handle = defaultSession().executions.getAgentHandleByStream(
      normalizedErrorChildStreamId,
    );
    expect(handle).toBeDefined();

    childStream.finalize({
      status: STREAM_STATUS.READY,
      errorMessage: 'tool failed after reporting ready',
    });

    expect(StreamStatusService.get(normalizedErrorChildStreamId)).toBe(
      STREAM_STATUS.ERROR,
    );
    await expect(handle?.result).resolves.toMatchObject({
      type: 'result',
      outcome: 'failed',
      executionId: normalizedErrorExecutionId,
      streamId: normalizedErrorChildStreamId,
      error: {
        kind: 'unexpected',
        message: 'tool failed after reporting ready',
      },
    });
  });
});
