// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/support/streamStatusTestUtils';
import { launchAgentCliSession } from '@tools/agentCliShared';
import {
  createChildStream,
  createRehydratedChildStream,
  type ChildStream,
} from '@tools/delegation/childStream';

// Local file imports
import {
  createRecordingHost,
  recordSessionEvents,
  runEventsOfType,
  sessionFactPayloads,
  sessionFactsOfType,
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
const noProjectionAutoCloseExecutionId = 'c11118' as ExecutionId;
const noProjectionAutoCloseChildStreamId = 'bash#c11118' as StreamTabId;
const workflowRelaunchExecutionId = 'c11119' as ExecutionId;
const workflowRelaunchChildStreamId = 'workflow-script#c11119' as StreamTabId;
const setupRetryExecutionId = 'c11120' as ExecutionId;
const setupRetryChildStreamId = 'workflow-script#c11120' as StreamTabId;
const allChildStreamIds = [
  childStreamId,
  orderingChildStreamId,
  loopChildStreamId,
  stoppedChildStreamId,
  cancelledChildStreamId,
  failedChildStreamId,
  noProjectionAutoCloseChildStreamId,
  workflowRelaunchChildStreamId,
  setupRetryChildStreamId,
];
const config = {
  agentCategory: AgentCategory.ToolUse,
  model: 'test-model',
  agent: 'test-agent',
} as unknown as AgentConfig;

function startBashChild(executionId: ExecutionId) {
  return createChildStream(executionId, parentStreamId, {
    streamPrefix: 'bash',
    run: { kind: 'process', tool: 'bash' },
    description: 'Run a background bash command',
    config,
  });
}

function startCodexChild(executionId: ExecutionId, description: string) {
  return createChildStream(executionId, parentStreamId, {
    streamPrefix: 'codex',
    run: { kind: 'agent', agent: 'codex', tool: 'codex' },
    description,
    config,
  });
}

/** Collect session-scope facts from the default session hub until detached. */
function collectSessionFacts(onlyType?: string) {
  const facts: unknown[] = [];
  const detach = defaultSession().events.subscribe((event) => {
    if (event.scope !== 'session') return;
    if (onlyType != null && event.event.type !== onlyType) return;
    facts.push(event);
  });
  return { facts, detach };
}

/**
 * Run `run` with a run-scope subscriber attached to the default session hub.
 * Creating or finalizing a child stream activates it, and the hub asserts a
 * run-scope subscriber is already attached at that point; the recorded events
 * themselves are not asserted here.
 */
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
    for (const streamId of allChildStreamIds) {
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
    try {
      const childStream = startBashChild(orderingExecutionId);
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
    const recorded = recordSessionEvents(defaultSession().events);

    try {
      const childStream = startBashChild(executionId);

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
      expect(sessionFactsOfType(recorded.events, 'status')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            streamId: childStreamId,
            phase: STREAM_PHASE.RUNNING,
            cause: 'lifecycle',
          }),
          expect.objectContaining({
            streamId: childStreamId,
            phase: STREAM_PHASE.COMPLETED,
            previousPhase: STREAM_PHASE.RUNNING,
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
                agentName: 'bash',
                status: STREAM_PHASE.RUNNING,
                identity: { kind: 'process', tool: 'bash' },
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
    const firstRun = withSessionEventRecording(() =>
      createChildStream(workflowRelaunchExecutionId, parentStreamId, {
        streamPrefix: 'workflow-script',
        run: { kind: 'multiAgentWorkflow', workflowName: 'draft-sections' },
        description: 'Run a named child task',
        config,
      }),
    );
    await withSessionEventRecording(() => firstRun.finalize());
    expect(defaultSession().status.get(workflowRelaunchChildStreamId)).toBe(
      STREAM_PHASE.COMPLETED,
    );

    const recorded = recordSessionEvents(defaultSession().events);
    const relaunched = await createRehydratedChildStream(
      workflowRelaunchExecutionId,
      parentStreamId,
      {
        streamPrefix: 'workflow-script',
        run: { kind: 'multiAgentWorkflow', workflowName: 'draft-sections' },
        description: 'Resume the named child task',
        config,
      },
    );

    try {
      expect(defaultSession().status.get(workflowRelaunchChildStreamId)).toBe(
        STREAM_PHASE.RUNNING,
      );
      expect(
        defaultSession().executions.getActiveChildren(parentStreamId),
      ).toContainEqual(
        expect.objectContaining({
          childStreamId: workflowRelaunchChildStreamId,
          executionId: workflowRelaunchExecutionId,
          status: STREAM_PHASE.RUNNING,
        }),
      );
      expect(sessionFactsOfType(recorded.events, 'status')).toContainEqual(
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

  it('rolls back a failed rehydrated setup so the same stream can retry', async () => {
    const recorded = recordSessionEvents(defaultSession().events);
    const trackExecution = vi
      .spyOn(defaultSession().executions, 'trackAgentExecution')
      .mockImplementationOnce(() => {
        throw new Error('execution setup failed');
      });
    const options = {
      streamPrefix: 'workflow-script',
      run: {
        kind: 'multiAgentWorkflow' as const,
        workflowName: 'retry-setup',
      },
      description: 'Retry a failed child stream setup',
      config,
    };

    try {
      await expect(
        createRehydratedChildStream(
          setupRetryExecutionId,
          parentStreamId,
          options,
        ),
      ).rejects.toThrow('execution setup failed');
      expect(
        sessionFactPayloads(recorded.events, 'removeStream'),
      ).not.toContainEqual({ streamId: setupRetryChildStreamId });
      expect(
        sessionFactPayloads(recorded.events, 'setActiveStream'),
      ).not.toContainEqual(
        expect.objectContaining({ streamId: setupRetryChildStreamId }),
      );

      const retried = await createRehydratedChildStream(
        setupRetryExecutionId,
        parentStreamId,
        options,
      );
      expect(retried.childStreamId).toBe(setupRetryChildStreamId);
      expect(
        sessionFactPayloads(recorded.events, 'setActiveStream'),
      ).toContainEqual(
        expect.objectContaining({ streamId: setupRetryChildStreamId }),
      );
      await retried.finalize();
    } finally {
      trackExecution.mockRestore();
      recorded.detach();
    }
  });

  it('emits workflow-script identity independently of its worker config', async () => {
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
          streamPrefix: 'workflow-script',
          run: {
            kind: 'multiAgentWorkflow',
            workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
          },
          description: 'Audit the repository without editing',
          config: workerConfig,
        },
      );

      expect(runEventsOfType(recorded.events, 'run.start')).toContainEqual(
        expect.objectContaining({
          identity: {
            kind: 'multiAgentWorkflow',
            workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
          },
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
    const { facts, detach } = collectSessionFacts('setActiveStream');

    try {
      const childStream = startBashChild(executionId);

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
      detach();
    }
  });

  it('publishes child stream auto-close as a session fact without direct host emission', async () => {
    const active = createRecordingHost();
    const { facts, detach } = collectSessionFacts();

    try {
      const childStream = startBashChild(noProjectionAutoCloseExecutionId);

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
      detach();
    }
  });

  it('emits removeStream for child stream auto-close', async () => {
    const recorded = recordSessionEvents(defaultSession().events);

    try {
      const childStream = startBashChild(executionId);

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

  it('finalizes a child stream when agent CLI loop setup fails synchronously', async () => {
    const setupError = new Error('child loop setup failed');
    const session = defaultSession();
    const recorded = recordSessionEvents(session.events);
    let childStream: ChildStream | undefined;
    let childExecutionId: ExecutionId | undefined;
    let handle: ReturnType<typeof session.executions.getAgentHandleByStream>;

    try {
      await expect(
        launchAgentCliSession({
          parentStreamId,
          parentExecutionId: undefined,
          agentName: 'codex',
          streamPrefix: 'codex',
          description: 'Fail during synchronous loop setup',
          config,
          registerFailedMessage: 'registration failed',
          startLoop: (context) => {
            childStream = context.childStream;
            childExecutionId = context.executionId;
            handle = session.executions.getAgentHandleByStream(
              context.childStream.childStreamId,
            );
            throw setupError;
          },
          summary: 'unreachable',
          launchedLine: 'unreachable',
          followUpLine: 'unreachable',
        }),
      ).rejects.toBe(setupError);

      expect(childStream).toBeDefined();
      expect(childExecutionId).toBeDefined();
      expect(handle).toBeDefined();
      if (!childStream || !childExecutionId || !handle) {
        throw new Error('expected the failed child launch to be captured');
      }
      expect(session.executions.getHandle(childExecutionId)).toBeUndefined();
      expect(session.status.get(childStream.childStreamId)).toBe(
        STREAM_PHASE.FAILED,
      );
      await expect(handle.result).resolves.toMatchObject({
        type: 'result',
        outcome: 'failed',
        executionId: childExecutionId,
        streamId: childStream.childStreamId,
      });
    } finally {
      recorded.detach();
      if (childStream) {
        clearStreamStatusForTest(session.status, childStream.childStreamId);
      }
    }
  });

  it('publishes child loop status changes through the child stream owner', async () => {
    const recorded = recordSessionEvents(defaultSession().events);

    const childStream = startCodexChild(
      loopExecutionId,
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
      sessionFactsOfType(recorded.events, 'status')
        .filter((event) => event.streamId === loopChildStreamId)
        .map((event) => event.phase),
    ).toEqual([
      STREAM_PHASE.WAITING,
      STREAM_PHASE.RUNNING,
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

  // The child reports its own exit and nothing else: every mid-loop report
  // below is refused by the status machine because a stop already cancelled
  // the stream, and `finalizeRunTerminal` resolves the run's terminal outcome
  // from that phase rather than from the failure the child reports.
  it('settles a stopped child loop as cancelled from the stream phase', async () => {
    const recorded = recordSessionEvents(defaultSession().events);

    const childStream = startCodexChild(
      stoppedExecutionId,
      'Run a stopped Codex child loop',
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(stoppedChildStreamId);
    expect(handle).toBeDefined();
    seedStreamStatusForTest(defaultSession().status, stoppedChildStreamId, {
      phase: STREAM_PHASE.CANCELLED,
    });
    recorded.events.splice(0);

    try {
      childStream.waitForInput();
      childStream.beginTurn();
      childStream.failTurn();
      await childStream.finalize({ outcome: { kind: 'failed' } });

      expect(defaultSession().status.get(stoppedChildStreamId)).toBe(
        STREAM_PHASE.CANCELLED,
      );
      expect(
        sessionFactsOfType(recorded.events, 'status').filter(
          (event) => event.streamId === stoppedChildStreamId,
        ),
      ).toHaveLength(0);
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
    const childStream = withSessionEventRecording(() =>
      startCodexChild(
        cancelledExecutionId,
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
    const childStream = withSessionEventRecording(() =>
      startCodexChild(failedExecutionId, 'Run a failing Codex child loop'),
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(failedChildStreamId);
    expect(handle).toBeDefined();

    await withSessionEventRecording(() =>
      childStream.finalize({
        outcome: { kind: 'failed', errorMessage: 'child process exited 1' },
      }),
    );

    expect(defaultSession().status.get(failedChildStreamId)).toBe(
      STREAM_PHASE.FAILED,
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
});
