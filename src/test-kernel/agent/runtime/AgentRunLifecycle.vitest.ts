import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { FinalizeExecutionResult } from '@agent/storage';
import { noopTrace, TraceEmitter, type StatusEvent } from '@agent/trace';
import {
  acquireResumedExecutionLease,
  inspectExecutionLease,
  releaseOwnedExecutionLease,
} from '@agent/storage/executionLease';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  AgentExecutionHandle,
  type AgentRunHandle,
  type LiveToolUseFlowContext,
} from '@agent/runtime/ExecutionHandle';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  finalizeRunTerminal,
  runFlowWithLifecycle,
} from '@agent/runtime/AgentRunLifecycle';
import {
  type ToolUseFlowResult,
  type WaitingToolUseFlowResult,
  type WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { platform } from '@platform/platform';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { agentKey, AgentCategory } from '@shared/schemas/agent';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import {
  executionLeasePath,
  writeForeignLease,
} from '@test/support/executionLeaseFixtures';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { installPlatform } from '@test/support/setupPlatform';
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/support/streamStatusTestUtils';
import { withTranscriptWriter } from '@test/support/storeTestDrivers';
import { StorageFS } from '@utils/files/storageFS';

import {
  recordSessionEvents,
  runEventsOfType,
  sessionFactsOfType,
} from '../progressTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeExecution: vi.fn(
    async (input: {
      flowRecord: 'preserve' | 'delete';
    }): Promise<FinalizeExecutionResult> => ({
      status: 'durable',
      outcomePersisted: true,
      flowRecord: input.flowRecord === 'delete' ? 'deleted' : 'preserved',
    }),
  ),
}));

const channelTraceMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  finalizeExecution: storageMocks.finalizeExecution,
}));

vi.mock('@agent/trace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/trace')>();
  return {
    ...actual,
    createChannelTrace: vi.fn(() => ({
      ...actual.noopTrace,
      warn: channelTraceMocks.warn,
    })),
  };
});

beforeEach(() => {
  storageMocks.finalizeExecution.mockClear();
  channelTraceMocks.warn.mockClear();
});

async function initLifecycleTestPlatform(firstRunDone: boolean) {
  await installPlatform({
    globalState: {
      [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: firstRunDone,
    },
  });
  return platform();
}

let lifecycleFixtureCounter = 0;

function lifecycleFixture(
  slug: string,
  agent = 'test-agent',
  category: AgentCategory = AgentCategory.ToolUse,
): {
  executionId: ExecutionId;
  streamId: StreamTabId;
  streamStatus: StreamStatusMachine;
  ctx: AgentLaunchContext;
} {
  const executionId =
    `e${(lifecycleFixtureCounter++).toString(16).padStart(5, '0')}` as ExecutionId;
  const streamId = `stream-${slug}` as StreamTabId;
  return {
    executionId,
    streamId,
    streamStatus: defaultSession().status,
    ctx: createTestLaunchContext({ executionId, streamId, agent, category }),
  };
}

function toolUseResult(
  executionId: ExecutionId,
  streamId: StreamTabId,
  outcome: RunOutcome,
): ToolUseFlowResult {
  return { category: 'toolUse', outcome, executionId, streamId };
}

function workflowResult(
  executionId: ExecutionId,
  streamId: StreamTabId,
  outcome: RunOutcome,
): WorkflowFlowResult {
  return {
    category: 'workflow',
    outcome,
    executionId,
    streamId,
    outputs: [],
    compileFailures: [],
  };
}

function waitingResult(
  executionId: ExecutionId,
  streamId: StreamTabId,
): WaitingToolUseFlowResult {
  return {
    category: 'toolUse',
    outcome: STREAM_PHASE.WAITING,
    executionId,
    streamId,
  };
}

/**
 * Returns the suspended handle for a run that reported WAITING.
 *
 * The fake runners below return the WAITING outcome without driving the real
 * `transitionToWaiting()`, so the stream phase never reaches WAITING here —
 * which is the point: the handle's own suspension is what makes a stop tear
 * the run down, so no phase seeding is needed to reach that path.
 */
function takeWaitingHandle(executionId: ExecutionId): AgentExecutionHandle {
  const handle = defaultSession().executions.getHandle(executionId);
  expect(handle).toBeInstanceOf(AgentExecutionHandle);
  if (!(handle instanceof AgentExecutionHandle)) {
    throw new Error('Expected a suspended agent execution handle.');
  }
  return handle;
}

/** Gate the next finalizeExecution call on an explicit release. */
function parkNextFinalize(): { started: () => boolean; release: () => void } {
  let releasePersist: (() => void) | undefined;
  storageMocks.finalizeExecution.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releasePersist = () =>
          resolve({
            status: 'durable',
            outcomePersisted: true,
            flowRecord: 'deleted',
          });
      }),
  );
  return {
    started: () => releasePersist !== undefined,
    release: () => releasePersist?.(),
  };
}

/**
 * Seed the open run-group row a suspended run's parked teardown must (or must
 * not) close. Production writes it via the transcript recorder's stage.start
 * handler, which the fake runners in this file skip.
 */
function seedOpenRunGroup(
  ctx: AgentLaunchContext,
  streamId: StreamTabId,
): string {
  const parentStageId = ctx.parentStage.id;
  if (!parentStageId) {
    throw new Error('The fixture parent stage must carry an id.');
  }
  withTranscriptWriter(defaultSession().transcripts, streamId, (writer) =>
    writer.appendSettled({
      id: parentStageId,
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: 'info',
      timestamp: Date.now(),
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'run',
      data: { status: STREAM_PHASE.RUNNING, kind: 'run' },
    }),
  );
  return parentStageId;
}

describe('runFlowWithLifecycle', () => {
  it('interrupts and suppresses terminal persistence after lease takeover', async () => {
    vi.useFakeTimers();
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-lease-takeover',
    );
    await acquireResumedExecutionLease(executionId);

    try {
      const result = await runFlowWithLifecycle(ctx, async (handle) => {
        await writeForeignLease(executionId);
        await vi.advanceTimersByTimeAsync(15_000);

        expect(handle.executionLeaseLost).toBe(true);
        expect(ctx.runScope.signal.aborted).toBe(true);
        return toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED);
      });

      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      expect(storageMocks.finalizeExecution).not.toHaveBeenCalled();
    } finally {
      await releaseOwnedExecutionLease(executionId);
      await StorageFS.delete(executionLeasePath(executionId)).catch(() => {});
      clearStreamStatusForTest(streamStatus, streamId);
      vi.useRealTimers();
    }
  });

  // The run's category reaches the handle and the terminal `result` through
  // the one descriptor the lifecycle builds, so a workflow run reports
  // `workflow` on both without either side re-deriving the string.
  it('reports the config agent category on the handle and terminal result', async () => {
    await initLifecycleTestPlatform(true);
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-workflow-category',
      'polish',
      AgentCategory.Workflow,
    );
    let terminalResult: AgentRunHandle['result'] | undefined;

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async () =>
          workflowResult(executionId, streamId, RUN_OUTCOME.COMPLETED),
        {
          onRun: (handle) => {
            expect(handle.category).toBe('workflow');
            terminalResult = handle.result;
          },
        },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      await expect(terminalResult).resolves.toMatchObject({
        category: 'workflow',
        agentName: 'polish',
      });
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  // A completed session marks first-run onboarding done, except for the
  // built-in setup agent, which must leave the flag untouched.
  const onboardingCases = [
    {
      label:
        'does not complete first-run onboarding for qualified setup sessions',
      slug: 'setup-agent',
      agent: agentKey('builtInToolUse', SETUP_AGENT_NAME),
      expectedDone: false,
    },
    {
      label: 'completes first-run onboarding for non-setup completed sessions',
      slug: 'non-setup-agent',
      agent: 'assistant',
      expectedDone: true,
    },
  ] as const;

  for (const { label, slug, agent, expectedDone } of onboardingCases) {
    it(label, async () => {
      const fake = await initLifecycleTestPlatform(false);
      const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
        `lifecycle-${slug}`,
        agent,
      );

      try {
        await runFlowWithLifecycle(ctx, async () =>
          toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED),
        );

        expect(
          fake.globalState.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE),
        ).toBe(expectedDone);
      } finally {
        clearStreamStatusForTest(streamStatus, streamId);
      }
    });
  }

  it('persists terminal state before updating onboarding state', async () => {
    const fake = await initLifecycleTestPlatform(false);
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'terminal-before-onboarding',
      'assistant',
    );
    const updateOnboarding = vi.spyOn(fake.globalState, 'update');

    try {
      await runFlowWithLifecycle(ctx, async () =>
        toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED),
      );

      expect(storageMocks.finalizeExecution).toHaveBeenCalledOnce();
      expect(updateOnboarding).toHaveBeenCalledWith(
        GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
        true,
      );
      expect(
        storageMocks.finalizeExecution.mock.invocationCallOrder[0],
      ).toBeLessThan(
        updateOnboarding.mock.invocationCallOrder[0] ??
          Number.POSITIVE_INFINITY,
      );
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('finalizes the status machine owned by the run session', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-status-owner',
    );

    try {
      // The lifecycle owns the whole transition (RUNNING on entry, terminal
      // on exit) against the run session's one status machine.
      expect(streamStatus).toBe(ctx.runScope.session.status);
      await runFlowWithLifecycle(ctx, async () =>
        toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED),
      );

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('projects run config before the RUNNING status projection', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-run-config-before-running',
    );
    const trace = new TraceEmitter();
    const detachTrace = ctx.runScope.session.attachRunTrace(trace, streamId);
    // Record both scopes: run.config travels on the run rail while status is
    // a session fact — the ordering assertion spans the two.
    const recorded = recordSessionEvents(ctx.runScope.session.events);
    ctx.logger = trace;
    ctx.disposeTrace = detachTrace;

    try {
      await runFlowWithLifecycle(ctx, async () =>
        toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED),
      );

      const runConfigIndex = recorded.events.findIndex(
        (event) => event.scope === 'run' && event.event.type === 'run.config',
      );
      const runningIndex = recorded.events.findIndex((event) => {
        if (event.scope !== 'session' || event.event.type !== 'status') {
          return false;
        }
        return (
          event.event.streamId === streamId &&
          event.event.phase === STREAM_PHASE.RUNNING
        );
      });

      expect(runConfigIndex).toBeGreaterThanOrEqual(0);
      expect(runningIndex).toBeGreaterThanOrEqual(0);
      expect(runConfigIndex).toBeLessThan(runningIndex);
    } finally {
      recorded.detach();
      detachTrace();
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('admits run start from a stale terminal phase via resume semantics', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-stale-terminal-start',
    );

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.FAILED,
      });

      await runFlowWithLifecycle(ctx, async () => {
        expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
        return toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED);
      });

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('clears a stale resuming substate when a resumed run starts', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-resuming-substate-start',
    );

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
        substate: STREAM_SUBSTATE.RESUMING,
      });

      await runFlowWithLifecycle(ctx, async () => {
        expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
        expect(streamStatus.getSubstate(streamId)).toBeUndefined();
        return toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED);
      });

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('does not emit a status event when starting an already-running stream with no substate', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-steady-running-no-substate',
    );

    const recorded = recordSessionEvents(ctx.runScope.session.events, {
      scope: 'session',
    });
    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      await runFlowWithLifecycle(ctx, async () => {
        expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
        expect(streamStatus.getSubstate(streamId)).toBeUndefined();
        expect(sessionFactsOfType(recorded.events, 'status')).toEqual([]);
        return toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED);
      });

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
      recorded.detach();
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('delivers subagent aborts through the terminal callback', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-abort',
    );
    ctx.attachedMemoryMisses = [
      { path: '/memories/missing.md', reason: 'not found' },
    ];
    const onError = vi.fn();

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async () => {
          throw new DOMException('Request aborted', 'AbortError');
        },
        { isSubagent: true, onError },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(result.memoryMisses).toEqual(ctx.attachedMemoryMisses);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][1]).toEqual(result);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('keeps subagent errors registered until terminal delivery runs', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-error-registered',
    );
    const onError = vi.fn(() => {
      expect(defaultSession().executions.getHandle(executionId)).toBeDefined();
    });

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async () => {
          throw new Error('subagent failed');
        },
        { isSubagent: true, onError },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
      expect(onError).toHaveBeenCalledOnce();
      expect(
        defaultSession().executions.getHandle(executionId),
      ).toBeUndefined();
    } finally {
      defaultSession().executions.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('keeps native subagent WAITING results registered and nonterminal', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-waiting',
    );
    const onError = vi.fn();
    await acquireResumedExecutionLease(executionId);

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async () => {
          expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
          expect(
            streamStatus.transition(streamId, STREAM_PHASE.WAITING, 'wait'),
          ).toBe(true);
          return waitingResult(executionId, streamId);
        },
        { isSubagent: true, onError },
      );

      expect(result.outcome).toBe(STREAM_PHASE.WAITING);
      expect(storageMocks.finalizeExecution).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
      expect(defaultSession().executions.getHandle(executionId)).toBeDefined();
      await expect(inspectExecutionLease(executionId)).resolves.toMatchObject({
        status: 'owned',
      });
    } finally {
      await releaseOwnedExecutionLease(executionId);
      defaultSession().executions.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('does not let a stop abandon a run that completes without suspending', async () => {
    // The window a stop could once fall into: the run has returned, its live
    // interrupt context is detached, and its own finalize is parked at the
    // persist await with the handle still tracked. Only the WAITING branch
    // parks a handle, so there is no suspension for the stop to find and
    // nothing the exit has to remember to clear.
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-completed-not-suspended',
    );
    const parked = parkNextFinalize();

    try {
      const running = runFlowWithLifecycle(
        ctx,
        async () => toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED),
        { isSubagent: true },
      );
      await vi.waitFor(() => expect(parked.started()).toBe(true));

      expect(defaultSession().executions.kill(executionId)).toBe(false);

      parked.release();
      const result = await running;
      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
      expect(
        defaultSession().executions.getHandle(executionId),
      ).toBeUndefined();
    } finally {
      defaultSession().executions.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('carries workflowPhase on the first child roster emission', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-workflow-phase',
    );
    const parentStreamId = 'parent-lifecycle-workflow-phase' as StreamTabId;
    const recorded = recordSessionEvents(ctx.runScope.session.events, {
      scope: 'run',
      streamId: parentStreamId,
      types: ['child.activity'],
    });
    // `track()` emits the roster synchronously, so onRun — which fires after
    // tracking — is structurally too late to stamp a display field.
    let rosterEmissionsBeforeOnRun = -1;

    try {
      await runFlowWithLifecycle(
        ctx,
        async () => toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED),
        {
          isSubagent: true,
          parentStreamId,
          workflowPhase: 'Reduce',
          onRun: () => {
            rosterEmissionsBeforeOnRun = runEventsOfType(
              recorded.events,
              'child.activity',
            ).length;
          },
        },
      );

      const [firstRoster] = runEventsOfType(recorded.events, 'child.activity');
      expect(firstRoster?.items).toEqual([
        expect.objectContaining({
          executionId,
          childStreamId: streamId,
          workflowPhase: 'Reduce',
        }),
      ]);
      expect(rosterEmissionsBeforeOnRun).toBeGreaterThan(0);
    } finally {
      recorded.detach();
      defaultSession().executions.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('replays a stop requested by onRun once interruption is attached', async () => {
    const { executionId, streamId, ctx } = lifecycleFixture(
      'lifecycle-early-stop',
    );
    const interrupt = vi.fn();

    const result = await runFlowWithLifecycle(
      ctx,
      async (handle) => {
        expect(defaultSession().status.get(streamId)).toBe(
          STREAM_PHASE.CANCELLED,
        );
        const flowContext: LiveToolUseFlowContext = {
          session: { appendFollowUp: vi.fn() },
          modelHandler: { supportsManualCompaction: false },
          requestImmediateCompaction: vi.fn(),
          modelSwitchDisabledReason: vi.fn(),
          switchModel: vi.fn().mockResolvedValue(undefined),
          interrupt,
        };
        handle.attachToolUseFlow(flowContext, ctx.runScope.signal);
        expect(interrupt).toHaveBeenCalledOnce();
        handle.detachToolUseFlow(flowContext);
        return toolUseResult(executionId, streamId, RUN_OUTCOME.CANCELLED);
      },
      {
        onRun: () => {
          expect(defaultSession().executions.kill(executionId)).toBe(true);
        },
      },
    );

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
  });

  // The stream is reused across runs, so a run that never claims it inherits
  // whatever the last one left. A stop landing in the track()-to-start window
  // is refused by the phase table while that leftover is terminal, so without
  // the start-time claim this run would adopt the previous run's COMPLETED as
  // its own verdict and drop its abort facts.
  it('does not adopt a previous run terminal phase when a stop lands before start', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-stale-phase-early-stop',
    );
    let terminalResult: AgentRunHandle['result'] | undefined;

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.COMPLETED,
      });

      const result = await runFlowWithLifecycle(
        ctx,
        async (handle) => {
          expect(ctx.runScope.signal.aborted).toBe(true);
          throw new DOMException('Request aborted', 'AbortError');
        },
        {
          onRun: (handle) => {
            terminalResult = handle.result;
            expect(defaultSession().executions.kill(executionId)).toBe(true);
          },
        },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(storageMocks.finalizeExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'preserve',
        }),
      );
      await expect(terminalResult).resolves.toMatchObject({
        outcome: RUN_OUTCOME.CANCELLED,
        error: { kind: 'abort' },
      });
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  // The claim above is a repair for an inherited phase, not a second start: a
  // stop that already reads CANCELLED on the stream is this run's outcome too,
  // so a run that never ran must not publish a RUNNING blip on the way out.
  it('publishes no RUNNING blip when the stop that beat run start already cancelled the stream', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-early-stop-no-blip',
    );
    const changes: StatusEvent[] = [];
    const detachStatus = defaultSession().events.subscribeStatus((event) => {
      if (event.streamId === streamId) changes.push(event);
    });

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async () => {
          throw new DOMException('Request aborted', 'AbortError');
        },
        {
          onRun: () => {
            expect(defaultSession().executions.kill(executionId)).toBe(true);
          },
        },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(changes.map((change) => change.phase)).toEqual([
        STREAM_PHASE.CANCELLED,
      ]);
    } finally {
      detachStatus();
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  // Outcome and flow-record disposition are one decision: a run the phase says
  // was interrupted keeps the record that makes it resumable, even when its own
  // report reached completion first.
  it('keeps the flow record of a stopped run whose report says completed', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-stop-during-completion',
    );

    try {
      const result = await runFlowWithLifecycle(ctx, async () => {
        expect(defaultSession().executions.kill(executionId)).toBe(true);
        expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
        return toolUseResult(executionId, streamId, RUN_OUTCOME.COMPLETED);
      });

      // The caller receives the same verdict persistence carries: the stop
      // won on the stream, so the flow's COMPLETED report is relabeled.
      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeExecution).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'preserve',
        }),
      );
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  // The parent's delivery is a projection of the same terminal fact as the
  // persisted history, so a stopped child never arrives formatted as a failure.
  it('delivers a stopped subagent as cancelled when its flow reports a failure', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-stop-then-failure',
    );
    const onError = vi.fn();

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async () => {
          expect(defaultSession().executions.kill(executionId)).toBe(true);
          throw new Error('child exited with code 143');
        },
        { isSubagent: true, onError },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(storageMocks.finalizeExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
        }),
      );
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][1]).toEqual(result);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('lets a stop/kill tear down a subagent suspended at WAITING (issue #7287)', async () => {
    const { executionId, streamId, ctx } = lifecycleFixture(
      'lifecycle-subagent-waiting-kill',
    );
    const followUpsTerminalize = vi.spyOn(
      ctx.runScope.session.followUps,
      'terminalize',
    );

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async () => waitingResult(executionId, streamId),
        { isSubagent: true },
      );

      expect(result.outcome).toBe(STREAM_PHASE.WAITING);
      expect(defaultSession().executions.getHandle(executionId)).toBeDefined();
      expect(followUpsTerminalize).not.toHaveBeenCalled();
      expect(storageMocks.finalizeExecution).not.toHaveBeenCalled();
      // The fixture's ctx.logger is noopTrace, and the run handle carries it
      // as its trace channel.
      const traceEmit = vi.spyOn(noopTrace, 'emit');

      const waitingHandle = takeWaitingHandle(executionId);

      // Seed the open run-group row this suspension's parked teardown must
      // close.
      const parentStageId = seedOpenRunGroup(ctx, streamId);

      // runToolUseFlow's finally detaches this stream's interrupt handler but
      // preserves the follow-up queue for WAITING — it does not dispose the
      // session — by the time a native subagent suspends at WAITING (not
      // reproduced by this fake runner, but true in production — see
      // runToolUseFlow.ts). With no interrupt target left, `executions.kill()`
      // falls back to the teardown the WAITING branch parked and tears the
      // execution down.
      expect(defaultSession().executions.kill(executionId)).toBe(true);
      await waitingHandle.result;

      // The bypassed runFlowWithLifecycle can't emit the terminal result, so
      // terminateWaitingHandle must — trace subscribers would otherwise miss
      // the stop entirely.
      expect(traceEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          outcome: 'cancelled',
          executionId,
        }),
      );
      traceEmit.mockRestore();

      expect(
        defaultSession().executions.getHandle(executionId),
      ).toBeUndefined();
      expect(defaultSession().status.get(streamId)).toBe(
        STREAM_PHASE.CANCELLED,
      );
      expect(followUpsTerminalize).toHaveBeenCalledWith(streamId);
      await vi.waitFor(() =>
        expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
          executionId,
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'delete',
        }),
      );
      // The kill path never resumes, so the per-suspension parent stage must
      // be closed here rather than dangling open forever. `ctx.parentStage`
      // is already desubscribed by this point (disposeTrace ran in the
      // WAITING branch's own finally), so the stage's GROUP_END entry is
      // written directly to the transcript store instead of through the
      // now-inert `ctx.parentStage.end()`.
      expect(
        defaultSession().transcripts.get(streamId)?.toJSON() ?? [],
      ).toContainEqual(
        expect.objectContaining({
          id: parentStageId,
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          data: expect.objectContaining({
            status: RUN_OUTCOME.CANCELLED,
            kind: 'run',
          }),
        }),
      );
    } finally {
      defaultSession().executions.untrack(executionId);
      clearStreamStatusForTest(defaultSession().status, streamId);
    }
  });

  it('does not close a waiting transcript group after lease loss', async () => {
    const { executionId, streamId, ctx } = lifecycleFixture(
      'lifecycle-waiting-cleanup-lease-loss',
    );
    const transcripts = ctx.runScope.session.transcripts;
    const originalLoadAndAcquireWriter =
      transcripts.loadAndAcquireWriter.bind(transcripts);
    let markWriterLoadStarted = (): void => undefined;
    const writerLoadStarted = new Promise<void>((resolve) => {
      markWriterLoadStarted = resolve;
    });
    let releaseWriterLoad = (): void => undefined;
    const writerLoadGate = new Promise<void>((resolve) => {
      releaseWriterLoad = resolve;
    });
    vi.spyOn(transcripts, 'loadAndAcquireWriter').mockImplementationOnce(
      async (requestedStreamId, ownerKey) => {
        markWriterLoadStarted();
        await writerLoadGate;
        return originalLoadAndAcquireWriter(requestedStreamId, ownerKey);
      },
    );

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async () => waitingResult(executionId, streamId),
        { isSubagent: true },
      );
      expect(result.outcome).toBe(STREAM_PHASE.WAITING);
      const waitingHandle = takeWaitingHandle(executionId);

      // Seed the open run-group row so a wrongly-run close would be visible
      // as a GROUP_END settle on this exact row (mirrors the kill test).
      const parentStageId = seedOpenRunGroup(ctx, streamId);

      expect(defaultSession().executions.kill(executionId)).toBe(true);
      await writerLoadStarted;
      waitingHandle.markExecutionLeaseLost();
      releaseWriterLoad();
      await waitingHandle.result;

      // The waiting group must stay open: the seeded row is still the
      // running GROUP_START, and no run GROUP_END row exists.
      const rows = transcripts.get(streamId)?.toJSON() ?? [];
      expect(rows).toContainEqual(
        expect.objectContaining({
          id: parentStageId,
          type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
        }),
      );
      expect(rows).not.toContainEqual(
        expect.objectContaining({
          type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
          data: expect.objectContaining({ kind: 'run' }),
        }),
      );
      expect(storageMocks.finalizeExecution).not.toHaveBeenCalled();
    } finally {
      releaseWriterLoad();
      defaultSession().executions.untrack(executionId);
      clearStreamStatusForTest(defaultSession().status, streamId);
    }
  });

  // The canonical outcome is decided once and projected three ways. This
  // matrix pins the projections for every terminal path — in particular that
  // a user stop (the no-throw `cancelled` exit, the dominant stop path)
  // persists `interrupted` and ends the stage with the literal `cancelled`
  // outcome. `stage.end()` writes the native `RunOutcome`, so
  // completed/cancelled/failed stay distinct on the transcript row.
  it('projects returned outcomes to terminal status, stage end, and stream status', async () => {
    const cases = [
      {
        outcome: RUN_OUTCOME.COMPLETED,
        stream: STREAM_PHASE.COMPLETED,
      },
      {
        outcome: RUN_OUTCOME.CANCELLED,
        stream: STREAM_PHASE.CANCELLED,
      },
      {
        outcome: RUN_OUTCOME.FAILED,
        stream: STREAM_PHASE.FAILED,
      },
    ] as const;

    for (const expected of cases) {
      const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
        `outcome-${expected.outcome}`,
      );
      const stageEnd = vi.spyOn(ctx.parentStage, 'end');

      try {
        const result = await runFlowWithLifecycle(ctx, async () =>
          toolUseResult(executionId, streamId, expected.outcome),
        );

        expect(result.outcome).toBe(expected.outcome);
        expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
          executionId,
          outcome: expected.outcome,
          flowRecord:
            expected.outcome === RUN_OUTCOME.COMPLETED ? 'delete' : 'preserve',
        });
        expect(stageEnd).toHaveBeenCalledWith(expected.outcome);
        expect(streamStatus.get(streamId)).toBe(expected.stream);
      } finally {
        clearStreamStatusForTest(streamStatus, streamId);
      }
    }
  });

  it('projects a thrown abort as cancelled on its own stage outcome', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'outcome-thrown-abort',
    );
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');

    try {
      const result = await runFlowWithLifecycle(ctx, async () => {
        throw new DOMException('Request aborted', 'AbortError');
      });

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
        executionId,
        outcome: RUN_OUTCOME.CANCELLED,
        flowRecord: 'preserve',
      });
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.CANCELLED);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('projects an unexpected throw as failed', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'outcome-thrown-error',
    );
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');

    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => {
          throw new Error('model exploded');
        }),
      ).rejects.toThrow('model exploded');

      expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
        executionId,
        outcome: RUN_OUTCOME.FAILED,
        flowRecord: 'preserve',
      });
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('terminalizes a waiting stream when the lifecycle catch path fails', async () => {
    const { streamId, streamStatus, ctx } = lifecycleFixture(
      'outcome-waiting-thrown-error',
    );

    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => {
          expect(
            streamStatus.transition(streamId, STREAM_PHASE.WAITING, 'wait'),
          ).toBe(true);
          throw new Error('wait node failed');
        }),
      ).rejects.toThrow('wait node failed');

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('passes flow-carried terminal results to subagent error delivery', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-flow-error',
    );
    const carriedResult = {
      category: 'toolUse' as const,
      outcome: RUN_OUTCOME.FAILED,
      executionId,
      streamId,
      totalCostUsd: 0.73,
      error: { message: 'subagent failed', userRetryable: false },
    };
    const onError = vi.fn();

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      const result = await runFlowWithLifecycle(
        ctx,
        async () => carriedResult,
        {
          isSubagent: true,
          onError,
        },
      );

      expect(result).toEqual(carriedResult);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'subagent failed' }),
        carriedResult,
      );
    } finally {
      defaultSession().executions.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('publishes the structured error facts a flow carried out on its result', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-carried-flow-error',
    );
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');
    const emit = vi.spyOn(ctx.logger, 'emit');

    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse' as const,
          outcome: RUN_OUTCOME.FAILED,
          executionId,
          streamId,
          response: 'partial answer',
          error: {
            message: 'provider exploded',
            userRetryable: true,
            statusCode: 503,
          },
        })),
      ).rejects.toThrow('provider exploded');

      // A carried failure is exactly as loud as a thrown one: same terminal
      // status, same stage outcome, same classified error on the result event.
      expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
        executionId,
        outcome: RUN_OUTCOME.FAILED,
        flowRecord: 'preserve',
      });
      expect(stageEnd).toHaveBeenCalledWith(RUN_OUTCOME.FAILED);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          outcome: RUN_OUTCOME.FAILED,
          error: expect.objectContaining({
            kind: 'unexpected',
            statusCode: 503,
            userRetryable: true,
          }),
        }),
      );
    } finally {
      emit.mockRestore();
      defaultSession().executions.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('classifies a carried missing-api-key failure through the flattened flag', async () => {
    const { executionId, streamId, ctx } = lifecycleFixture(
      'lifecycle-carried-missing-key',
    );
    const emit = vi.spyOn(ctx.logger, 'emit');

    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse' as const,
          outcome: RUN_OUTCOME.FAILED,
          executionId,
          streamId,
          response: '',
          // The retry-state flatten drops the Error and its Symbol marker;
          // the carried flag is what keeps the kind reachable at this exit.
          error: {
            message: 'Missing OpenRouter API key.',
            userRetryable: false,
            missingApiKey: true as const,
          },
        })),
      ).rejects.toThrow('Missing OpenRouter API key.');

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'result',
          outcome: RUN_OUTCOME.FAILED,
          error: expect.objectContaining({ kind: 'missing-api-key' }),
        }),
      );
    } finally {
      emit.mockRestore();
      defaultSession().executions.untrack(executionId);
    }
  });
});

/** The handle, status machine, and untrack spy every finalize test drives. */
function finalizeFixture(slug: string): {
  executionId: string;
  streamId: StreamTabId;
  streamStatus: StreamStatusMachine;
  handle: ReturnType<typeof testExecutionHandle>;
  untrack: Mock<(executionId: string) => void>;
} {
  const executionId = `exec-${slug}`;
  const streamId = `stream-${slug}` as StreamTabId;
  return {
    executionId,
    streamId,
    streamStatus: new StreamStatusMachine(new SessionEventHub()),
    handle: testExecutionHandle({
      executionId,
      parentStreamId: streamId,
      agent: 'test-agent',
      trace: noopTrace,
    }),
    untrack: vi.fn<(executionId: string) => void>(),
  };
}

describe('finalizeRunTerminal', () => {
  // The exactly-once guard must be an atomic, synchronous claim — not a
  // check-then-await on the settled flag. Two finalizers racing across the
  // persist await (e.g. a lifecycle arm vs a concurrent finalize of the same
  // handle) would otherwise both pass the check before the first settles and
  // double-publish persist/emit/settle/untrack.
  it('finalizes exactly once when two callers race across the persist await', async () => {
    const { executionId, streamId, streamStatus, handle, untrack } =
      finalizeFixture('finalize-race');
    const traceEmit = vi.spyOn(noopTrace, 'emit');
    // Park the first caller at its persist await so the second caller arrives
    // while the first has not yet emitted or settled anything.
    const parked = parkNextFinalize();

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });
      const params = {
        handle,
        executions: { untrack },
        streamStatus,
        outcome: RUN_OUTCOME.COMPLETED,
        isSubagent: false,
        trace: noopTrace,
        persistence: { kind: 'finalize', flowRecord: 'delete' },
      } as const;

      const first = finalizeRunTerminal(params);
      const second = finalizeRunTerminal(params);

      // The loser no-ops without waiting on (or duplicating) the persist.
      await expect(second).resolves.toBeUndefined();
      expect(parked.started()).toBe(true);
      parked.release();
      const event = await first;

      expect(event).toMatchObject({
        outcomePersisted: true,
        event: {
          type: 'result',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId,
          streamId,
        },
      });
      expect(storageMocks.finalizeExecution).toHaveBeenCalledTimes(1);
      // The stream-status transition also emits on the trace; the terminal
      // `result` event itself must be published exactly once.
      expect(
        traceEmit.mock.calls.filter(
          ([emitted]) => (emitted as { type: string }).type === 'result',
        ),
      ).toHaveLength(1);
      expect(untrack).toHaveBeenCalledTimes(1);
      await expect(handle.result).resolves.toBe(event?.event);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
      traceEmit.mockRestore();
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('flushes display artifacts before publishing and untracking', async () => {
    const { executionId, streamId, streamStatus, handle, untrack } =
      finalizeFixture('finalize-artifact-order');
    let releaseFlush: (() => void) | undefined;
    const flushArtifacts = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
    );
    let resultSettled = false;
    void handle.result.then(() => {
      resultSettled = true;
    });

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });
      const finalization = finalizeRunTerminal({
        handle,
        executions: { untrack },
        streamStatus,
        outcome: RUN_OUTCOME.COMPLETED,
        isSubagent: false,
        trace: noopTrace,
        persistence: { kind: 'skip' },
        flushArtifacts,
      });

      await vi.waitFor(() => expect(flushArtifacts).toHaveBeenCalledOnce());
      expect(resultSettled).toBe(false);
      expect(untrack).not.toHaveBeenCalled();

      releaseFlush?.();
      await finalization;

      expect(resultSettled).toBe(true);
      expect(untrack).toHaveBeenCalledExactlyOnceWith(executionId);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('settles and untracks once while reporting terminal metadata failure', async () => {
    const { executionId, streamId, streamStatus, handle, untrack } =
      finalizeFixture('finalize-metadata-failure');
    const durabilityError = new Error('metadata disk write failed');
    storageMocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      stage: 'terminal-status',
      outcomePersisted: false,
      error: durabilityError,
    });

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.RUNNING,
      });

      const event = await finalizeRunTerminal({
        handle,
        executions: { untrack },
        streamStatus,
        outcome: RUN_OUTCOME.FAILED,
        isSubagent: false,
        trace: noopTrace,
        persistence: { kind: 'finalize', flowRecord: 'preserve' },
      });

      expect(event).toMatchObject({
        outcomePersisted: false,
        event: {
          type: 'result',
          outcome: RUN_OUTCOME.FAILED,
          executionId,
        },
      });
      await expect(handle.result).resolves.toBe(event?.event);
      expect(untrack).toHaveBeenCalledExactlyOnceWith(executionId);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
      expect(channelTraceMocks.warn).toHaveBeenCalledExactlyOnceWith(
        'Failed to finalize durable execution state',
        {
          data: {
            agentIdentifier: 'test-agent',
            executionId,
            stage: 'terminal-status',
            outcomePersisted: false,
            error: durabilityError,
          },
        },
      );
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  // The stream phase is the single owner of a run's terminal outcome. A
  // stop/kill transitions the phase behind the run's back, and the run it
  // killed then reports its own non-zero exit as a failure — so the phase, not
  // the report, has to decide, and no caller may cross-check it for itself.
  it('resolves the terminal outcome from an already-cancelled stream phase', async () => {
    const { executionId, streamId, streamStatus, handle, untrack } =
      finalizeFixture('finalize-stopped');
    const stage = { end: vi.fn() };

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.CANCELLED,
      });

      const finalized = await finalizeRunTerminal({
        handle,
        executions: { untrack },
        streamStatus,
        outcome: RUN_OUTCOME.FAILED,
        error: { kind: 'unexpected', message: 'exited with code 143' },
        isSubagent: false,
        stage,
        trace: noopTrace,
        persistence: { kind: 'finalize', flowRecord: 'delete' },
      });

      expect(finalized?.event).toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.CANCELLED,
        executionId,
        streamId,
      });
      // Error facts classified for a failure that the phase says never
      // happened must not ride the cancelled result.
      expect(finalized?.event.error).toBeUndefined();
      await expect(handle.result).resolves.toBe(finalized?.event);
      expect(stage.end).toHaveBeenCalledExactlyOnceWith(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: RUN_OUTCOME.CANCELLED,
        }),
      );
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
      // The resolution is what keeps the terminal transition from being
      // refused, so nothing is left to warn about.
      expect(channelTraceMocks.warn).not.toHaveBeenCalled();
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  // The same ownership rule in the other direction: a phase that already
  // published FAILED is a terminal fact a later stop cannot rewrite, so a
  // caller reporting `cancelled` does not get to relabel it.
  it('keeps an already-failed stream phase over a later cancelled report', async () => {
    const { executionId, streamId, streamStatus, handle, untrack } =
      finalizeFixture('finalize-failed-then-stopped');

    try {
      seedStreamStatusForTest(streamStatus, streamId, {
        phase: STREAM_PHASE.FAILED,
      });

      const finalized = await finalizeRunTerminal({
        handle,
        executions: { untrack },
        streamStatus,
        outcome: RUN_OUTCOME.CANCELLED,
        isSubagent: false,
        trace: noopTrace,
        persistence: { kind: 'skip' },
      });

      expect(finalized?.event).toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.FAILED,
        executionId,
        streamId,
      });
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
      expect(channelTraceMocks.warn).not.toHaveBeenCalled();
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });
});
