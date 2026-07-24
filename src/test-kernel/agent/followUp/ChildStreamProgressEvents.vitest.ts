// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  STREAM_PHASE,
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import { createChildStream } from '@tools/childStream';

// Local file imports
import {
  createRecordingHost,
  recordSessionEvents,
  runEventsOfType,
  sessionFactPayloads,
} from '../progressTestUtils';

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
const noProjectionAutoCloseExecutionId = 'c11118' as ExecutionId;
const noProjectionAutoCloseChildStreamId = 'bash#c11118' as StreamTabId;
const workflowRelaunchExecutionId = 'c11119' as ExecutionId;
const workflowRelaunchChildStreamId = 'workflow-script#c11119' as StreamTabId;
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
    runKind: 'agent',
    agentName: 'codex',
    description,
    config,
    toolName: 'codex',
  });
}

function withSessionEventRecording<T>(run: () => T): T {
  const recorded = recordSessionEvents(defaultSession().events);
  try {
    const result = run();
    if (result instanceof Promise) {
      return result.finally(recorded.detach) as T;
    }
    recorded.detach();
    return result;
  } catch (err) {
    recorded.detach();
    throw err;
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
      noProjectionAutoCloseChildStreamId,
      workflowRelaunchChildStreamId,
    ]) {
      clearStreamStatusForTest(defaultSession().status, streamId);
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
    const detachEvents = session.events.subscribe((event) => {
      if (event.scope === 'session' && event.event.type === 'setActiveStream') {
        sequence.push('fact:setActiveStream');
      }
    });
    const host = {
      emit: (event: string, payload: unknown) => {
        sequence.push(`emit:${event}`);
        (active.host.emit as (event: string, payload: unknown) => void)(
          event,
          payload,
        );
      },
    } as AgentRuntimeHost;

    try {
      const childStream = createChildStream(
        orderingExecutionId,
        parentStreamId,
        {
          runtimeHost: host,
          streamPrefix: 'bash',
          streamCategory: AgentCategory.ToolUse,
          runKind: 'process',
          agentName: 'test-agent',
          description: 'Run a background bash command',
          config,
          toolName: 'bash',
        },
      );
      void childStream.finalize({ autoClose: true });

      expect(assertSpy).toHaveBeenCalledWith(orderingChildStreamId);
      expect(sequence.slice(0, 2)).toEqual([
        `assert:${orderingChildStreamId}`,
        'fact:setActiveStream',
      ]);
    } finally {
      detachEvents();
      assertSpy.mockRestore();
    }
  });

  it('publishes child stream lifecycle events through the session hub', async () => {
    const active = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession().events);

    try {
      const childStream = createChildStream(executionId, parentStreamId, {
        runtimeHost: active.host,
        streamPrefix: 'bash',
        streamCategory: AgentCategory.ToolUse,
        runKind: 'process',
        agentName: 'test-agent',
        description: 'Run a background bash command',
        config,
        toolName: 'bash',
      });

      expect(childStream.childStreamId).toBe(childStreamId);

      await childStream.finalize({ autoClose: true });

      expect(
        sessionFactPayloads(recorded.events, 'setActiveStream'),
      ).toContainEqual({
        streamId: childStreamId,
        agentCategory: AgentCategory.ToolUse,
        suppressViewSwitch: true,
      });
      expect(runEventsOfType(recorded.events, 'run.config')).toContainEqual(
        expect.objectContaining({ streamId: childStreamId, executionId }),
      );
      expect(
        sessionFactPayloads(recorded.events, 'updateStreamDescription'),
      ).toContainEqual({
        streamId: childStreamId,
        description: 'Run a background bash command',
      });
      expect(runEventsOfType(recorded.events, 'status')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            streamId: childStreamId,
            phase: STREAM_STATUS.RUNNING,
            cause: 'lifecycle',
          }),
          expect.objectContaining({
            streamId: childStreamId,
            phase: STREAM_PHASE.COMPLETED,
            previousPhase: STREAM_STATUS.RUNNING,
            cause: 'lifecycle',
          }),
        ]),
      );
      expect(runEventsOfType(recorded.events, 'child.activity')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            parentStreamId,
            items: [
              expect.objectContaining({
                executionId,
                childStreamId,
                agentName: 'test-agent',
                status: STREAM_STATUS.RUNNING,
                toolName: 'bash',
              }),
            ],
          }),
          expect.objectContaining({
            parentStreamId,
            items: [],
          }),
        ]),
      );
      expect(
        sessionFactPayloads(recorded.events, 'setParentStream'),
      ).toContainEqual({
        childStreamId,
        parentStreamId,
      });
      expect(
        sessionFactPayloads(recorded.events, 'removeStream'),
      ).toContainEqual({
        streamId: childStreamId,
      });
    } finally {
      recorded.detach();
    }
  });

  it('marks a deterministic child-stream relaunch as running', async () => {
    const active = createRecordingHost();
    const firstRun = withSessionEventRecording(() =>
      createChildStream(workflowRelaunchExecutionId, parentStreamId, {
        runtimeHost: active.host,
        streamPrefix: 'workflow-script',
        streamCategory: AgentCategory.Workflow,
        runKind: 'workflowScript',
        agentName: 'draft-sections',
        description: 'Run a named child task',
        config,
        toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
      }),
    );
    await withSessionEventRecording(() => firstRun.finalize());
    expect(defaultSession().status.get(workflowRelaunchChildStreamId)).toBe(
      STREAM_PHASE.COMPLETED,
    );

    const recorded = recordSessionEvents(defaultSession().events);
    const relaunched = createChildStream(
      workflowRelaunchExecutionId,
      parentStreamId,
      {
        runtimeHost: active.host,
        streamPrefix: 'workflow-script',
        streamCategory: AgentCategory.Workflow,
        runKind: 'workflowScript',
        agentName: 'draft-sections',
        description: 'Resume the named child task',
        config,
        toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
      },
    );

    try {
      expect(defaultSession().status.get(workflowRelaunchChildStreamId)).toBe(
        STREAM_PHASE.RUNNING,
      );
      expect(
        defaultSession().executions.getActiveChildren(parentStreamId).subagents,
      ).toContainEqual(
        expect.objectContaining({
          childStreamId: workflowRelaunchChildStreamId,
          executionId: workflowRelaunchExecutionId,
          status: STREAM_PHASE.RUNNING,
        }),
      );
      expect(runEventsOfType(recorded.events, 'status')).toContainEqual(
        expect.objectContaining({
          cause: 'resume',
          phase: STREAM_PHASE.RUNNING,
          previousPhase: STREAM_PHASE.COMPLETED,
          streamId: workflowRelaunchChildStreamId,
        }),
      );
    } finally {
      await relaunched.finalize();
      recorded.detach();
    }
  });

  it('emits workflow-script identity independently of its worker config', async () => {
    const active = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession().events);
    const workerConfig = {
      ...config,
      agent: 'generic',
      agentCategory: AgentCategory.Workflow,
    };

    try {
      const childStream = createChildStream(
        workflowRelaunchExecutionId,
        parentStreamId,
        {
          runtimeHost: active.host,
          streamPrefix: 'workflow-script',
          streamCategory: AgentCategory.Workflow,
          runKind: 'workflowScript',
          agentName: 'repo-cleanup-readonly-pilot-2026-07-24',
          description: 'Audit the repository without editing',
          config: workerConfig,
          toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
        },
      );

      expect(runEventsOfType(recorded.events, 'run.start')).toContainEqual(
        expect.objectContaining({
          descriptor: expect.objectContaining({
            agent: 'repo-cleanup-readonly-pilot-2026-07-24',
            category: AgentCategory.Workflow,
            kind: 'workflowScript',
          }),
        }),
      );
      expect(
        defaultSession().executions.getAgentHandleByStream(
          workflowRelaunchChildStreamId,
        ),
      ).toMatchObject({
        agentName: 'repo-cleanup-readonly-pilot-2026-07-24',
        category: AgentCategory.Workflow,
      });

      await childStream.finalize();
    } finally {
      recorded.detach();
    }
  });

  it('publishes child stream activation through the session fact hub', async () => {
    const active = createRecordingHost();
    const facts: unknown[] = [];
    const detachFacts = defaultSession().events.subscribe((event) => {
      if (event.scope === 'session' && event.event.type === 'setActiveStream') {
        facts.push(event);
      }
    });

    try {
      const childStream = createChildStream(executionId, parentStreamId, {
        runtimeHost: active.host,
        streamPrefix: 'bash',
        streamCategory: AgentCategory.ToolUse,
        runKind: 'process',
        agentName: 'test-agent',
        description: 'Run a background bash command',
        config,
        toolName: 'bash',
      });

      expect(active.events).toEqual([]);
      expect(facts).toEqual([
        {
          scope: 'session',
          event: {
            type: 'setActiveStream',
            payload: {
              streamId: childStreamId,
              agentCategory: AgentCategory.ToolUse,
              suppressViewSwitch: true,
            },
          },
        },
      ]);

      await childStream.finalize();
    } finally {
      detachFacts();
    }
  });

  it('publishes child stream auto-close as a session fact without direct host emission', async () => {
    const active = createRecordingHost();
    const facts: unknown[] = [];
    const detachFacts = defaultSession().events.subscribe((event) => {
      if (event.scope === 'session') {
        facts.push(event);
      }
    });

    try {
      const childStream = createChildStream(
        noProjectionAutoCloseExecutionId,
        parentStreamId,
        {
          runtimeHost: active.host,
          streamPrefix: 'bash',
          streamCategory: AgentCategory.ToolUse,
          runKind: 'process',
          agentName: 'test-agent',
          description: 'Run a background bash command',
          config,
          toolName: 'bash',
        },
      );

      await childStream.finalize({ autoClose: true });

      expect(active.events).toEqual([]);
      expect(facts).toContainEqual({
        scope: 'session',
        event: {
          type: 'removeStream',
          payload: { streamId: noProjectionAutoCloseChildStreamId },
        },
      });
    } finally {
      detachFacts();
    }
  });

  it('emits removeStream for child stream auto-close', async () => {
    const active = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession().events);

    try {
      const childStream = createChildStream(executionId, parentStreamId, {
        runtimeHost: active.host,
        streamPrefix: 'bash',
        streamCategory: AgentCategory.ToolUse,
        runKind: 'process',
        agentName: 'test-agent',
        description: 'Run a background bash command',
        config,
        toolName: 'bash',
      });

      await childStream.finalize({ autoClose: true });

      expect(
        sessionFactPayloads(recorded.events, 'removeStream'),
      ).toContainEqual({
        streamId: childStreamId,
      });
    } finally {
      recorded.detach();
    }
  });

  it('publishes child loop status changes through the child stream owner', async () => {
    const active = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession().events);

    const childStream = startCodexChild(
      loopExecutionId,
      active.host,
      'Run a long-lived Codex child loop',
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(loopChildStreamId);
    expect(handle).toBeDefined();
    recorded.events.splice(0);

    try {
      childStream.waitForInput();
      childStream.beginTurn();
      childStream.failTurn();
      await childStream.finalize({ outcome: { kind: 'failed' } });
    } finally {
      recorded.detach();
    }

    expect(
      runEventsOfType(recorded.events, 'status').map((event) => event.phase),
    ).toEqual([
      STREAM_STATUS.WAITING,
      STREAM_STATUS.RUNNING,
      STREAM_PHASE.FAILED,
    ]);
    expect(defaultSession().status.get(loopChildStreamId)).toBe(
      STREAM_PHASE.FAILED,
    );
    expect(
      runEventsOfType(recorded.events, 'child.activity').at(-1),
    ).toMatchObject({
      parentStreamId,
      items: [],
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
    const recorded = recordSessionEvents(defaultSession().events);

    const childStream = startCodexChild(
      stoppedExecutionId,
      active.host,
      'Run a stopped Codex child loop',
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(stoppedChildStreamId);
    expect(handle).toBeDefined();
    seedStreamStatusForTest(
      defaultSession().status,
      stoppedChildStreamId,
      STREAM_PHASE.CANCELLED,
    );
    recorded.events.splice(0);

    try {
      childStream.waitForInput();
      childStream.beginTurn();
      childStream.failTurn();
      await childStream.finalize({ outcome: { kind: 'failed' } });

      expect(defaultSession().status.get(stoppedChildStreamId)).toBe(
        STREAM_PHASE.CANCELLED,
      );
      expect(runEventsOfType(recorded.events, 'status')).toHaveLength(0);
      await expect(handle?.result).resolves.toMatchObject({
        type: 'result',
        outcome: 'cancelled',
        executionId: stoppedExecutionId,
        streamId: stoppedChildStreamId,
      });
    } finally {
      recorded.detach();
    }
  });

  it('settles child handle results as cancelled for stopped finalization', async () => {
    const active = createRecordingHost();

    const childStream = withSessionEventRecording(() =>
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

    await withSessionEventRecording(() =>
      childStream.finalize({ outcome: { kind: 'cancelled' } }),
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

    const childStream = withSessionEventRecording(() =>
      startCodexChild(
        failedExecutionId,
        active.host,
        'Run a failing Codex child loop',
      ),
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(failedChildStreamId);
    expect(handle).toBeDefined();

    await withSessionEventRecording(() =>
      childStream.finalize({
        outcome: { kind: 'failed', errorMessage: 'child process exited 1' },
      }),
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

  it('fails finalization when the outcome carries an errorMessage', async () => {
    const active = createRecordingHost();

    const childStream = withSessionEventRecording(() =>
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

    await withSessionEventRecording(() =>
      childStream.finalize({
        outcome: {
          kind: 'failed',
          errorMessage: 'tool failed after reporting ready',
        },
      }),
    );

    expect(defaultSession().status.get(normalizedErrorChildStreamId)).toBe(
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
