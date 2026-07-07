// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import type { ProgressEventPayloads } from '@agent/runtime/hostProgressEvents';
import {
  STREAM_PHASE,
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { createChildStream } from '@tools/childStream';
import { createRecordingHost } from '../progressTestUtils';
import { attachSessionProgressEventProjectionForTest } from '../sessionProgressTestUtils';

const executionId = 'c11111' as ExecutionId;
const parentStreamId = 'stream:parent' as StreamTabId;
const childStreamId = 'bash#c11111' as StreamTabId;
const orderingExecutionId = 'c11112' as ExecutionId;
const orderingChildStreamId = 'bash#c11112' as StreamTabId;
const loopExecutionId = 'c11113' as ExecutionId;
const loopChildStreamId = 'codex#c11113' as StreamTabId;
const stoppedExecutionId = 'c11114' as ExecutionId;
const stoppedChildStreamId = 'codex#c11114' as StreamTabId;
const cancelledExecutionId = 'c11115' as ExecutionId;
const cancelledChildStreamId = 'codex#c11115' as StreamTabId;
const failedExecutionId = 'c11116' as ExecutionId;
const failedChildStreamId = 'codex#c11116' as StreamTabId;
const normalizedErrorExecutionId = 'c11117' as ExecutionId;
const normalizedErrorChildStreamId = 'codex#c11117' as StreamTabId;
const config = {
  agentCategory: AgentCategory.ToolUse,
  model: 'test-model',
  agent: 'test-agent',
} as unknown as AgentConfig;

function startCodexChild(
  executionId: ExecutionId,
  host: AgentRuntimeHost,
  description: string,
) {
  return createChildStream(executionId, parentStreamId, {
    runtimeHost: host,
    streamPrefix: 'codex',
    streamCategory: AgentCategory.ToolUse,
    agentName: 'codex',
    description,
    config,
    toolName: 'codex',
  });
}

function withSessionProgressProjection<T>(
  host: AgentRuntimeHost,
  run: () => T,
): T {
  const detach = attachSessionProgressEventProjectionForTest(
    defaultSession().events,
    host,
  );
  try {
    return run();
  } finally {
    detach();
  }
}

describe('child stream progress events', () => {
  afterEach(() => {
    for (const streamId of [
      childStreamId,
      orderingChildStreamId,
      loopChildStreamId,
      stoppedChildStreamId,
      cancelledChildStreamId,
      failedChildStreamId,
      normalizedErrorChildStreamId,
    ]) {
      clearStreamStatusForTest(StreamStatusService, streamId);
    }
  });

  it('attaches child run subscribers before activating the stream', () => {
    const active = createRecordingHost();
    const session = defaultSession();
    const sequence: string[] = [];
    const originalAssert =
      session.events.assertRunSubscribersAttachedBeforeActivation.bind(
        session.events,
      );
    const assertSpy = vi
      .spyOn(session.events, 'assertRunSubscribersAttachedBeforeActivation')
      .mockImplementation((streamId) => {
        sequence.push(`assert:${streamId}`);
        expect(active.events.map((entry) => entry.event)).not.toContain(
          'setActiveStream',
        );
        originalAssert(streamId);
      });
    const host: AgentRuntimeHost = {
      emit: (event, payload) => {
        sequence.push(`emit:${event}`);
        active.host.emit(event, payload);
      },
    };

    try {
      const childStream = withSessionProgressProjection(host, () =>
        createChildStream(orderingExecutionId, parentStreamId, {
          runtimeHost: host,
          streamPrefix: 'bash',
          streamCategory: AgentCategory.ToolUse,
          agentName: 'test-agent',
          description: 'Run a background bash command',
          config,
          toolName: 'bash',
        }),
      );
      childStream.finalize({ autoClose: true });

      expect(assertSpy).toHaveBeenCalledWith(orderingChildStreamId);
      expect(sequence.slice(0, 2)).toEqual([
        `assert:${orderingChildStreamId}`,
        'emit:setActiveStream',
      ]);
    } finally {
      assertSpy.mockRestore();
    }
  });

  it('publishes child stream lifecycle events through the explicit runtime host', () => {
    const active = createRecordingHost();

    const childStream = withSessionProgressProjection(active.host, () =>
      createChildStream(executionId, parentStreamId, {
        runtimeHost: active.host,
        streamPrefix: 'bash',
        streamCategory: AgentCategory.ToolUse,
        agentName: 'test-agent',
        description: 'Run a background bash command',
        config,
        toolName: 'bash',
      }),
    );

    expect(childStream.childStreamId).toBe(childStreamId);

    withSessionProgressProjection(active.host, () =>
      childStream.finalize({ autoClose: true }),
    );

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
        },
      },
    });
    expect(events[2]).toEqual({
      event: 'updateStreamDescription',
      payload: {
        streamId: childStreamId,
        description: 'Run a background bash command',
      },
    });
    expect(events[3]).toEqual({
      event: 'updateStreamStatus',
      payload: {
        streamId: childStreamId,
        status: STREAM_STATUS.RUNNING,
        cause: 'lifecycle',
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
        status: STREAM_PHASE.COMPLETED,
        previousStatus: STREAM_STATUS.RUNNING,
        cause: 'lifecycle',
      },
    });
    expect(events[8]).toEqual({
      event: 'removeStream',
      payload: { streamId: childStreamId },
    });
  });

  it('uses host interactions for child stream auto-close when available', () => {
    const active = createRecordingHost();
    const removedStreams: StreamTabId[] = [];
    const host: AgentRuntimeHost = {
      ...active.host,
      interactions: {
        handleProgressEvent: (event, payload) => {
          if (event !== 'removeStream') return false;
          const data = payload as ProgressEventPayloads['removeStream'];
          removedStreams.push(data.streamId);
          return true;
        },
        resolve: () => false,
        cancel: () => {},
      },
    };

    const childStream = withSessionProgressProjection(host, () =>
      createChildStream(executionId, parentStreamId, {
        runtimeHost: host,
        streamPrefix: 'bash',
        streamCategory: AgentCategory.ToolUse,
        agentName: 'test-agent',
        description: 'Run a background bash command',
        config,
        toolName: 'bash',
      }),
    );

    withSessionProgressProjection(host, () =>
      childStream.finalize({ autoClose: true }),
    );

    expect(removedStreams).toEqual([childStreamId]);
    expect(active.events.map((entry) => entry.event)).not.toContain(
      'removeStream',
    );
  });

  it('publishes child loop status changes through the child stream owner', async () => {
    const active = createRecordingHost();

    const childStream = withSessionProgressProjection(active.host, () =>
      startCodexChild(
        loopExecutionId,
        active.host,
        'Run a long-lived Codex child loop',
      ),
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(loopChildStreamId);
    expect(handle).toBeDefined();
    active.events.splice(0);

    childStream.waitForInput();
    childStream.beginTurn();
    childStream.failTurn();
    withSessionProgressProjection(active.host, () =>
      childStream.finalize({ status: STREAM_STATUS.ERROR }),
    );

    const statusEvents = active.events.filter(
      (entry) => entry.event === 'updateStreamStatus',
    );
    const statuses = statusEvents.map(
      (entry) => (entry.payload as { status: string }).status,
    );
    expect(statuses).toEqual([
      STREAM_STATUS.WAITING,
      STREAM_STATUS.RUNNING,
      STREAM_PHASE.FAILED,
    ]);
    expect(StreamStatusService.get(loopChildStreamId)).toBe(
      STREAM_PHASE.FAILED,
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

    const childStream = withSessionProgressProjection(active.host, () =>
      startCodexChild(
        stoppedExecutionId,
        active.host,
        'Run a stopped Codex child loop',
      ),
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(stoppedChildStreamId);
    expect(handle).toBeDefined();
    seedStreamStatusForTest(
      StreamStatusService,
      stoppedChildStreamId,
      STREAM_PHASE.CANCELLED,
    );
    active.events.splice(0);

    childStream.waitForInput();
    childStream.beginTurn();
    childStream.failTurn();
    withSessionProgressProjection(active.host, () =>
      childStream.finalize({ status: STREAM_STATUS.ERROR }),
    );

    expect(StreamStatusService.get(stoppedChildStreamId)).toBe(
      STREAM_PHASE.CANCELLED,
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

    const childStream = withSessionProgressProjection(active.host, () =>
      startCodexChild(
        cancelledExecutionId,
        active.host,
        'Run an interrupted Codex child loop',
      ),
    );
    const handle = defaultSession().executions.getAgentHandleByStream(
      cancelledChildStreamId,
    );
    expect(handle).toBeDefined();

    withSessionProgressProjection(active.host, () =>
      childStream.finalize({ status: STREAM_STATUS.STOPPED }),
    );

    await expect(handle?.result).resolves.toMatchObject({
      type: 'result',
      outcome: 'cancelled',
      executionId: cancelledExecutionId,
      streamId: cancelledChildStreamId,
    });
  });

  it('settles failed child handle results with error details', async () => {
    const active = createRecordingHost();

    const childStream = withSessionProgressProjection(active.host, () =>
      startCodexChild(
        failedExecutionId,
        active.host,
        'Run a failing Codex child loop',
      ),
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(failedChildStreamId);
    expect(handle).toBeDefined();

    withSessionProgressProjection(active.host, () =>
      childStream.finalize({ errorMessage: 'child process exited 1' }),
    );

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

    const childStream = withSessionProgressProjection(active.host, () =>
      startCodexChild(
        normalizedErrorExecutionId,
        active.host,
        'Run a child loop with mismatched finalization inputs',
      ),
    );
    const handle = defaultSession().executions.getAgentHandleByStream(
      normalizedErrorChildStreamId,
    );
    expect(handle).toBeDefined();

    withSessionProgressProjection(active.host, () =>
      childStream.finalize({
        status: STREAM_STATUS.READY,
        errorMessage: 'tool failed after reporting ready',
      }),
    );

    expect(StreamStatusService.get(normalizedErrorChildStreamId)).toBe(
      STREAM_PHASE.FAILED,
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
