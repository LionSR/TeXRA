// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  RUN_OUTCOME,
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
  eventsOfType,
  recordChildRosters,
  recordSessionEvents,
} from '../progressTestUtils';

const executionId = 'c11111' as ExecutionId;
const parentStreamId = 'stream:parent' as StreamTabId;
const childStreamId = 'bash#c11111' as StreamTabId;
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
    userFollowUpSupport: 'unsupported',
    description: 'Run a background bash command',
    config,
  });
}

function startCodexChild(executionId: ExecutionId, description: string) {
  return createChildStream(executionId, parentStreamId, {
    streamPrefix: 'codex',
    run: { kind: 'agent', agent: 'codex', tool: 'codex' },
    userFollowUpSupport: 'terminalBacked',
    description,
    config,
  });
}

describe('child stream progress events', () => {
  afterEach(() => {
    for (const streamId of allChildStreamIds) {
      clearStreamStatusForTest(defaultSession().status, streamId);
    }
  });

  it('publishes child stream lifecycle events through the session hub', async () => {
    const recorded = recordSessionEvents(defaultSession());
    const rosters = recordChildRosters(defaultSession().executions);

    const childStream = startBashChild(executionId);

    expect(childStream.childStreamId).toBe(childStreamId);

    await childStream.finalize({
      outcome: RUN_OUTCOME.COMPLETED,
      autoClose: true,
    });

    expect(eventsOfType(recorded.events, 'run.start')).toContainEqual(
      expect.objectContaining({
        aggregateId: childStreamId,
        executionId,
        identity: { kind: 'process', tool: 'bash' },
        category: AgentCategory.ToolUse,
        isRemote: false,
        parentStreamId,
      }),
    );
    // The activation beside the existence fact, with no `isRemote`: the
    // frozen NDJSON line for a child never carried one.
    expect(eventsOfType(recorded.events, 'run.activate')).toMatchObject([
      {
        type: 'run.activate',
        aggregateId: childStreamId,
        category: AgentCategory.ToolUse,
        background: true,
      },
    ]);
    expect(eventsOfType(recorded.events, 'run.config')).toContainEqual(
      expect.objectContaining({ aggregateId: childStreamId, executionId }),
    );
    expect(
      eventsOfType(recorded.events, 'updateStreamDescription'),
    ).toContainEqual(
      expect.objectContaining({
        aggregateId: childStreamId,
        description: 'Run a background bash command',
      }),
    );
    expect(eventsOfType(recorded.events, 'status')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aggregateId: childStreamId,
          phase: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        }),
        expect.objectContaining({
          aggregateId: childStreamId,
          phase: STREAM_PHASE.COMPLETED,
          previousPhase: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        }),
      ]),
    );
    expect(rosters.rosters).toEqual(
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
    expect(eventsOfType(recorded.events, 'setParentStream')).toContainEqual(
      expect.objectContaining({
        aggregateId: childStreamId,
        parentStreamId,
      }),
    );
    expect(eventsOfType(recorded.events, 'stream.removed')).toContainEqual(
      expect.objectContaining({ aggregateId: childStreamId }),
    );
  });

  it('marks a deterministic child-stream relaunch as running', async () => {
    const firstRun = createChildStream(
      workflowRelaunchExecutionId,
      parentStreamId,
      {
        streamPrefix: 'workflow-script',
        run: { kind: 'multiAgentWorkflow', workflowName: 'draft-sections' },
        userFollowUpSupport: 'unsupported',
        description: 'Run a named child task',
        config,
      },
    );
    await firstRun.finalize({ outcome: RUN_OUTCOME.COMPLETED });
    expect(defaultSession().status.get(workflowRelaunchChildStreamId)).toBe(
      STREAM_PHASE.COMPLETED,
    );

    const recorded = recordSessionEvents(defaultSession());
    const relaunched = await createRehydratedChildStream(
      workflowRelaunchExecutionId,
      parentStreamId,
      {
        streamPrefix: 'workflow-script',
        run: { kind: 'multiAgentWorkflow', workflowName: 'draft-sections' },
        userFollowUpSupport: 'unsupported',
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
      expect(eventsOfType(recorded.events, 'status')).toContainEqual(
        expect.objectContaining({
          cause: 'resume',
          phase: STREAM_PHASE.RUNNING,
          previousPhase: STREAM_PHASE.COMPLETED,
          aggregateId: workflowRelaunchChildStreamId,
        }),
      );
    } finally {
      await relaunched.finalize({ outcome: RUN_OUTCOME.COMPLETED });
    }
  });

  it('rolls back a failed rehydrated setup so the same stream can retry', async () => {
    const recorded = recordSessionEvents(defaultSession());
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
      userFollowUpSupport: 'unsupported' as const,
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
        eventsOfType(recorded.events, 'stream.removed').map(
          (event) => event.aggregateId,
        ),
      ).not.toContain(setupRetryChildStreamId);
      // Setup failed after the existence fact, so the started stream ended
      // with its terminal result instead of lingering as a ghost.
      expect(eventsOfType(recorded.events, 'result')).toContainEqual(
        expect.objectContaining({
          aggregateId: setupRetryChildStreamId,
          outcome: RUN_OUTCOME.FAILED,
          isSubagent: true,
        }),
      );

      const retried = await createRehydratedChildStream(
        setupRetryExecutionId,
        parentStreamId,
        options,
      );
      expect(retried.childStreamId).toBe(setupRetryChildStreamId);
      expect(
        eventsOfType(recorded.events, 'run.start').filter(
          (event) => event.aggregateId === setupRetryChildStreamId,
        ),
      ).toHaveLength(2);
      await retried.finalize({ outcome: RUN_OUTCOME.COMPLETED });
    } finally {
      trackExecution.mockRestore();
    }
  });

  it('emits workflow-script identity independently of its worker config', async () => {
    const recorded = recordSessionEvents(defaultSession());
    const workerConfig = {
      ...config,
      agent: 'generic',
      agentCategory: AgentCategory.Workflow,
    };

    const childStream = createChildStream(
      workflowRelaunchExecutionId,
      parentStreamId,
      {
        streamPrefix: 'workflow-script',
        run: {
          kind: 'multiAgentWorkflow',
          workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
        },
        userFollowUpSupport: 'unsupported',
        description: 'Audit the repository without editing',
        config: workerConfig,
      },
    );

    expect(eventsOfType(recorded.events, 'run.start')).toContainEqual(
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

    await childStream.finalize({ outcome: RUN_OUTCOME.COMPLETED });
  });

  it('publishes child stream existence as a run fact without direct host emission', async () => {
    const active = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession());

    const childStream = startBashChild(executionId);

    expect(active.events).toEqual([]);
    expect(eventsOfType(recorded.events, 'run.start')).toEqual([
      expect.objectContaining({
        type: 'run.start',
        aggregateId: childStreamId,
        category: AgentCategory.ToolUse,
        parentStreamId,
      }),
    ]);

    await childStream.finalize({ outcome: RUN_OUTCOME.COMPLETED });
  });

  it('publishes child stream auto-close as a session fact without direct host emission', async () => {
    const active = createRecordingHost();
    const recorded = recordSessionEvents(defaultSession());

    const childStream = startBashChild(noProjectionAutoCloseExecutionId);

    await childStream.finalize({
      outcome: RUN_OUTCOME.COMPLETED,
      autoClose: true,
    });

    expect(active.events).toEqual([]);
    expect(eventsOfType(recorded.events, 'stream.removed')).toContainEqual(
      expect.objectContaining({
        aggregateId: noProjectionAutoCloseChildStreamId,
      }),
    );
  });

  it('emits removeStream for child stream auto-close', async () => {
    const recorded = recordSessionEvents(defaultSession());

    const childStream = startBashChild(executionId);

    await childStream.finalize({
      outcome: RUN_OUTCOME.COMPLETED,
      autoClose: true,
    });

    expect(eventsOfType(recorded.events, 'stream.removed')).toContainEqual(
      expect.objectContaining({ aggregateId: childStreamId }),
    );
  });

  it('finalizes a child stream when agent CLI loop setup fails synchronously', async () => {
    const setupError = new Error('child loop setup failed');
    const session = defaultSession();
    const recorded = recordSessionEvents(session);
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
      if (childStream) {
        clearStreamStatusForTest(session.status, childStream.childStreamId);
      }
    }
  });

  it('publishes child loop status changes through the child stream owner', async () => {
    const childStream = startCodexChild(
      loopExecutionId,
      'Run a long-lived Codex child loop',
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(loopChildStreamId);
    expect(handle).toBeDefined();
    // From here on: the launch's own facts are not the loop's.
    const recorded = recordSessionEvents(defaultSession());
    const rosters = recordChildRosters(defaultSession().executions);

    childStream.waitForInput();
    childStream.beginTurn();
    childStream.failTurn();
    await childStream.finalize({ outcome: RUN_OUTCOME.FAILED });

    expect(
      eventsOfType(recorded.events, 'status')
        .filter((event) => event.aggregateId === loopChildStreamId)
        .map((event) => event.phase),
    ).toEqual([
      STREAM_PHASE.WAITING,
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.FAILED,
    ]);
    expect(defaultSession().status.get(loopChildStreamId)).toBe(
      STREAM_PHASE.FAILED,
    );
    expect(rosters.rosters.at(-1)).toMatchObject({
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
    // From here on: the launch's own facts are not the loop's.
    const recorded = recordSessionEvents(defaultSession());

    childStream.waitForInput();
    childStream.beginTurn();
    childStream.failTurn();
    await childStream.finalize({ outcome: RUN_OUTCOME.FAILED });

    expect(defaultSession().status.get(stoppedChildStreamId)).toBe(
      STREAM_PHASE.CANCELLED,
    );
    expect(
      eventsOfType(recorded.events, 'status').filter(
        (event) => event.aggregateId === stoppedChildStreamId,
      ),
    ).toHaveLength(0);
    await expect(handle?.result).resolves.toMatchObject({
      type: 'result',
      outcome: 'cancelled',
      executionId: stoppedExecutionId,
      streamId: stoppedChildStreamId,
    });
  });

  it('settles child handle results as cancelled for stopped finalization', async () => {
    const childStream = startCodexChild(
      cancelledExecutionId,
      'Run an interrupted Codex child loop',
    );
    const handle = defaultSession().executions.getAgentHandleByStream(
      cancelledChildStreamId,
    );
    expect(handle).toBeDefined();

    await childStream.finalize({ outcome: RUN_OUTCOME.CANCELLED });

    await expect(handle?.result).resolves.toMatchObject({
      type: 'result',
      outcome: 'cancelled',
      executionId: cancelledExecutionId,
      streamId: cancelledChildStreamId,
    });
  });

  it('settles failed child handle results with error details', async () => {
    const childStream = startCodexChild(
      failedExecutionId,
      'Run a failing Codex child loop',
    );
    const handle =
      defaultSession().executions.getAgentHandleByStream(failedChildStreamId);
    expect(handle).toBeDefined();

    await childStream.finalize({
      outcome: RUN_OUTCOME.FAILED,
      error: new Error('child process exited 1'),
    });

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
