// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import {
  clearStreamStatusForTest,
  seedStreamStatusForTest,
} from '@test/helpers/streamStatusTestUtils';
import { platform } from '@platform/platform';
import { installPlatform } from '@test/support/setupPlatform';
import type { FinalizeExecutionResult } from '@agent/storage';
import { noopTrace, TraceEmitter } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  AgentExecutionHandle,
  type LiveToolUseFlowContext,
} from '@agent/runtime/executionRegistry';
import { createRunScope } from '@agent/runtime/RunScope';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  finalizeRunTerminal,
  runFlowWithLifecycle,
} from '@agent/runtime/AgentRunLifecycle';
import { AgentFlowError } from '@agent/runtime/AgentFlowResult';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  STREAM_STATUS,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { agentKey } from '@shared/schemas/agent';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { createRecordingHost, recordSessionEvents } from '../progressTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeExecution: vi.fn(
    async (input: {
      flowRecord: 'preserve' | 'delete';
    }): Promise<FinalizeExecutionResult> => ({
      status: 'durable',
      terminalStatusPersisted: true,
      flowRecord: input.flowRecord === 'delete' ? 'deleted' : 'preserved',
    }),
  ),
  synchronizeAgentResultOutcome: vi.fn().mockResolvedValue(undefined),
}));

const channelTraceMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  finalizeExecution: storageMocks.finalizeExecution,
  synchronizeAgentResultOutcome: storageMocks.synchronizeAgentResultOutcome,
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

async function initLifecycleTestPlatform(firstRunDone: boolean) {
  await installPlatform({
    globalState: {
      [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: firstRunDone,
    },
  });
  return platform();
}

function createLifecycleContext({
  executionId,
  streamId,
  agent = 'test-agent',
}: {
  executionId: ExecutionId;
  streamId: StreamTabId;
  agent?: string;
}): {
  ctx: AgentLaunchContext;
  explicit: ReturnType<typeof createRecordingHost>;
} {
  const explicit = createRecordingHost();
  const config = AgentConfigSchema.parse({
    agent,
    model: 'test-model',
    agentCategory: AgentCategory.ToolUse,
  });
  const setting = AgentSettingSchema.parse({
    agentCategory: AgentCategory.ToolUse,
  });
  const prompt = AgentPromptSchema.parse({});
  const storageKey = executionId as StorageKey;
  const session = defaultSession();
  const runScope = createRunScope({
    runtimeHost: explicit.host,
    streamId,
    executionId,
    agentName: config.agent,
    session,
  });
  const modelInfo = {
    capabilities: {
      supportsPromptCaching: false,
      supportsAutoPromptCaching: false,
      supportsReasoning: false,
      cacheDiscountFactor: 0,
    },
    config: {
      provider: ModelProvider.OPENAI,
      name: 'test-model',
      fullName: 'Test Model',
      inputPrice: 0,
      openRouterOnly: false,
      requiresResponsesAPI: false,
    },
  };

  const ctx: AgentLaunchContext = {
    config,
    setting,
    prompt,
    runScope,
    logger: noopTrace,
    parentStage: noopTrace.openStage('Run: test-agent'),
    storageKey,
    userVarChannels: {
      input: Object.freeze({}),
      transient: {},
    },
    attachedMemoryMisses: [],
    usageMonitor: new UsageMonitor(
      modelInfo,
      {
        logger: noopTrace,
        runtimeHost: explicit.host,
        storageKey,
        streamId,
      },
      {
        agentName: config.agent,
        agentCategory: setting.agentCategory,
      },
    ),
    modelHandler: {
      dispose: vi.fn(),
    } as unknown as AgentLaunchContext['modelHandler'],
    disposeTrace: vi.fn(),
  };
  return { ctx, explicit };
}

let lifecycleFixtureCounter = 0;

function lifecycleFixture(
  slug: string,
  agent?: string,
): {
  executionId: ExecutionId;
  streamId: StreamTabId;
  streamStatus: StreamStatusMachine;
  ctx: AgentLaunchContext;
  explicit: ReturnType<typeof createRecordingHost>;
} {
  const executionId =
    `e${(lifecycleFixtureCounter++).toString(16).padStart(5, '0')}` as ExecutionId;
  const streamId = `stream-${slug}` as StreamTabId;
  const streamStatus = defaultSession().status;
  const { ctx, explicit } = createLifecycleContext({
    executionId,
    streamId,
    agent,
  });
  return { executionId, streamId, streamStatus, ctx, explicit };
}

describe('runFlowWithLifecycle', () => {
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
        await runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId,
          streamId,
        }));

        expect(
          fake.globalState.get(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE),
        ).toBe(expectedDone);
      } finally {
        clearStreamStatusForTest(streamStatus, streamId);
      }
    });
  }

  it('finalizes the status machine owned by the run session', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-status-owner',
    );

    try {
      // The lifecycle owns the whole transition (RUNNING on entry, terminal
      // on exit) against the run session's one status machine.
      expect(streamStatus).toBe(ctx.runScope.session.status);
      await runFlowWithLifecycle(ctx, async () => ({
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId,
        streamId,
      }));

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
    const recorded = recordSessionEvents(ctx.runScope.session.events, {
      scope: 'run',
    });
    ctx.logger = trace;
    ctx.disposeTrace = detachTrace;

    try {
      await runFlowWithLifecycle(ctx, async () => ({
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId,
        streamId,
      }));

      const runConfigIndex = recorded.events.findIndex(
        (event) => event.scope === 'run' && event.event.type === 'run.config',
      );
      const runningIndex = recorded.events.findIndex((event) => {
        if (event.scope !== 'run' || event.event.type !== 'status') {
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
      seedStreamStatusForTest(streamStatus, streamId, STREAM_PHASE.FAILED);

      await runFlowWithLifecycle(ctx, async () => {
        expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
        return {
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId,
          streamId,
        };
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
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RESUMING);

      await runFlowWithLifecycle(ctx, async () => {
        expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
        expect(streamStatus.getSubstate(streamId)).toBeUndefined();
        return {
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId,
          streamId,
        };
      });

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('does not emit a status event when starting an already-running stream with no substate', async () => {
    const { executionId, streamId, streamStatus, ctx, explicit } =
      lifecycleFixture('lifecycle-steady-running-no-substate');

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_PHASE.RUNNING);

      await runFlowWithLifecycle(ctx, async () => {
        expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
        expect(streamStatus.getSubstate(streamId)).toBeUndefined();
        expect(
          explicit.events.filter(
            (entry) => entry.event === 'updateStreamStatus',
          ),
        ).toEqual([]);
        return {
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId,
          streamId,
        };
      });

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
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
    storageMocks.finalizeExecution.mockClear();

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async () => {
          expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.RUNNING);
          expect(
            streamStatus.transition(streamId, STREAM_PHASE.WAITING, 'wait'),
          ).toBe(true);
          return {
            category: 'toolUse',
            outcome: STREAM_PHASE.WAITING,
            executionId,
            streamId,
          };
        },
        { isSubagent: true, onError },
      );

      expect(result.outcome).toBe(STREAM_PHASE.WAITING);
      expect(storageMocks.finalizeExecution).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
      expect(defaultSession().executions.getHandle(executionId)).toBeDefined();
    } finally {
      defaultSession().executions.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('clears a pre-registered waiting-cleanup when the run completes without suspending', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-stale-waiting-cleanup',
    );
    const staleCleanup = vi.fn();
    let captured: AgentExecutionHandle | undefined;

    try {
      // Simulate a waiting-cleanup registered on this handle by some
      // caller, then the run completing normally without ever suspending.
      const result = await runFlowWithLifecycle(
        ctx,
        async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId,
          streamId,
        }),
        {
          isSubagent: true,
          onRun: (handle) => {
            captured = handle as AgentExecutionHandle;
            handle.registerWaitingCleanup(staleCleanup);
          },
        },
      );

      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      // The stale registration must be gone: nothing ran it, and a
      // terminate() racing into the teardown window must not find it.
      expect(staleCleanup).not.toHaveBeenCalled();
      expect(captured?.runWaitingCleanup()).toBe(false);
    } finally {
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
        handle.attachToolUseFlow(flowContext);
        expect(interrupt).toHaveBeenCalledOnce();
        handle.detachToolUseFlow(flowContext);
        return {
          category: 'toolUse',
          outcome: RUN_OUTCOME.CANCELLED,
          executionId,
          streamId,
        };
      },
      {
        onRun: () => {
          expect(defaultSession().executions.kill(executionId)).toBe(true);
        },
      },
    );

    expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
  });

  it('lets a stop/kill tear down a subagent suspended at WAITING (issue #7287)', async () => {
    const { executionId, streamId, ctx } = lifecycleFixture(
      'lifecycle-subagent-waiting-kill',
    );
    const followUpsRelease = vi.spyOn(
      ctx.runScope.session.followUps,
      'release',
    );
    const transcriptsUpdate = vi.spyOn(
      ctx.runScope.session.transcripts,
      'update',
    );
    storageMocks.finalizeExecution.mockClear();

    try {
      const result = await runFlowWithLifecycle(
        ctx,
        async () => ({
          category: 'toolUse',
          outcome: STREAM_PHASE.WAITING,
          executionId,
          streamId,
        }),
        { isSubagent: true },
      );

      expect(result.outcome).toBe(STREAM_PHASE.WAITING);
      expect(defaultSession().executions.getHandle(executionId)).toBeDefined();
      expect(followUpsRelease).not.toHaveBeenCalled();
      expect(storageMocks.finalizeExecution).not.toHaveBeenCalled();
      // The fixture's ctx.logger is noopTrace, and the run handle carries it
      // as its trace channel.
      const traceEmit = vi.spyOn(noopTrace, 'emit');

      // terminateWaitingHandle now requires the stream to have genuinely
      // reached WAITING (belt-and-suspenders confirmation the handle is
      // really parked, not mid-flight — see #7324 review discussion); this
      // fake runner returns the WAITING outcome directly but doesn't drive
      // the real transitionToWaiting() call, so seed it explicitly.
      seedStreamStatusForTest(
        defaultSession().status,
        streamId,
        STREAM_STATUS.WAITING,
      );

      // runToolUseFlow's finally detaches this stream's interrupt handler but
      // (post #7286) preserves the follow-up queue for WAITING — it does not
      // dispose the session — by the time a native subagent suspends at
      // WAITING (not reproduced by this fake runner, but true in production —
      // see runToolUseFlow.ts). Before the fix, `executions.kill()`
      // found no interrupt target for a suspended handle and silently
      // no-opped, leaving the handle stuck registered forever. It must now
      // fall back to the waiting-cleanup registered above and actually tear
      // the execution down.
      expect(defaultSession().executions.kill(executionId)).toBe(true);

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
      expect(followUpsRelease).toHaveBeenCalledWith(streamId);
      expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
        executionId,
        terminalStatus: EXECUTION_STATUS.INTERRUPTED,
        flowRecord: 'delete',
      });
      // The kill path never resumes, so the per-suspension parent stage must
      // be closed here rather than dangling open forever. `ctx.parentStage`
      // is already desubscribed by this point (disposeTrace ran in the
      // WAITING branch's own finally), so the fix writes the stage's
      // GROUP_END entry directly to the transcript store instead of calling
      // the now-inert `ctx.parentStage.end()`. The written status is the
      // literal `RunOutcome.CANCELLED` (#7993 step 2) — no
      // legacyEndGroupStatusForOutcome fold at this direct-write call site.
      expect(transcriptsUpdate).toHaveBeenCalledWith(
        streamId,
        expect.any(String),
        expect.objectContaining({
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

  // The canonical outcome is decided once and projected three ways. This
  // matrix pins the projections for every terminal path — in particular that
  // a user stop (the no-throw `cancelled` exit, the dominant stop path)
  // persists `interrupted` and ends the stage with the literal `cancelled`
  // outcome, distinct from `completed` (#7993 step 2: `stage.end()` writes
  // the native `RunOutcome`, not the folded 2-value `EndGroupStatus` string —
  // completed/cancelled/failed all end up distinct on the transcript row).
  it('projects returned outcomes to terminal status, stage end, and stream status', async () => {
    const cases = [
      {
        outcome: RUN_OUTCOME.COMPLETED,
        terminal: EXECUTION_STATUS.COMPLETED,
        stream: STREAM_PHASE.COMPLETED,
      },
      {
        outcome: RUN_OUTCOME.CANCELLED,
        terminal: EXECUTION_STATUS.INTERRUPTED,
        stream: STREAM_PHASE.CANCELLED,
      },
      {
        outcome: RUN_OUTCOME.FAILED,
        terminal: EXECUTION_STATUS.ERROR,
        stream: STREAM_PHASE.FAILED,
      },
    ] as const;

    for (const expected of cases) {
      const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
        `outcome-${expected.outcome}`,
      );
      const stageEnd = vi.spyOn(ctx.parentStage, 'end');
      storageMocks.finalizeExecution.mockClear();

      try {
        const result = await runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse',
          outcome: expected.outcome,
          executionId,
          streamId,
        }));

        expect(result.outcome).toBe(expected.outcome);
        expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
          executionId,
          terminalStatus: expected.terminal,
          flowRecord:
            expected.outcome === RUN_OUTCOME.COMPLETED ? 'delete' : 'preserve',
        });
        // The stage closes with the literal outcome — no
        // legacyEndGroupStatusForOutcome fold at this production call site.
        expect(stageEnd).toHaveBeenCalledWith(expected.outcome);
        expect(streamStatus.get(streamId)).toBe(expected.stream);
      } finally {
        clearStreamStatusForTest(streamStatus, streamId);
      }
    }
  });

  it('projects a thrown abort as cancelled (distinct stage outcome, not folded to stopped)', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'outcome-thrown-abort',
    );
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');
    storageMocks.finalizeExecution.mockClear();

    try {
      const result = await runFlowWithLifecycle(ctx, async () => {
        throw new DOMException('Request aborted', 'AbortError');
      });

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
        executionId,
        terminalStatus: EXECUTION_STATUS.INTERRUPTED,
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
    storageMocks.finalizeExecution.mockClear();

    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => {
          throw new Error('model exploded');
        }),
      ).rejects.toThrow('model exploded');

      expect(storageMocks.finalizeExecution).toHaveBeenCalledWith({
        executionId,
        terminalStatus: EXECUTION_STATUS.ERROR,
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
    };
    const onError = vi.fn();

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_STATUS.RUNNING);

      const result = await runFlowWithLifecycle(
        ctx,
        async () => {
          throw new AgentFlowError('subagent failed', carriedResult);
        },
        { isSubagent: true, onError },
      );

      expect(result).toEqual(carriedResult);
      expect(onError).toHaveBeenCalledWith(
        expect.any(AgentFlowError),
        carriedResult,
      );
    } finally {
      defaultSession().executions.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });
});

describe('finalizeRunTerminal', () => {
  // The exactly-once guard must be an atomic, synchronous claim — not a
  // check-then-await on the settled flag. Two finalizers racing across the
  // persist await (e.g. a lifecycle arm vs a concurrent finalize of the same
  // handle) would otherwise both pass the check before the first settles and
  // double-publish persist/emit/settle/untrack.
  it('finalizes exactly once when two callers race across the persist await', async () => {
    const executionId = 'exec-finalize-race';
    const streamId = 'stream-finalize-race' as StreamTabId;
    const streamStatus = new StreamStatusMachine();
    const explicit = createRecordingHost();
    const handle = new AgentExecutionHandle(
      executionId,
      streamId,
      streamId,
      'test-agent',
      'toolUse',
      explicit.host,
      noopTrace,
    );
    const untrack = vi.fn();
    const traceEmit = vi.spyOn(noopTrace, 'emit');
    storageMocks.finalizeExecution.mockClear();
    // Park the first caller at its persist await so the second caller arrives
    // while the first has not yet emitted or settled anything.
    let releasePersist: (() => void) | undefined;
    storageMocks.finalizeExecution.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePersist = () =>
            resolve({
              status: 'durable' as const,
              terminalStatusPersisted: true as const,
              flowRecord: 'deleted' as const,
            });
        }),
    );

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_PHASE.RUNNING);
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
      expect(releasePersist).toBeDefined();
      releasePersist?.();
      const event = await first;

      expect(event).toMatchObject({
        type: 'result',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId,
        streamId,
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
      await expect(handle.result).resolves.toBe(event);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
    } finally {
      traceEmit.mockRestore();
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('settles and untracks once while reporting terminal metadata failure', async () => {
    const executionId = 'exec-finalize-metadata-failure';
    const streamId = 'stream-finalize-metadata-failure' as StreamTabId;
    const streamStatus = new StreamStatusMachine();
    const handle = new AgentExecutionHandle(
      executionId,
      streamId,
      streamId,
      'test-agent',
      'toolUse',
      createRecordingHost().host,
      noopTrace,
    );
    const untrack = vi.fn();
    const durabilityError = new Error('metadata disk write failed');
    storageMocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      stage: 'terminal-status',
      terminalStatusPersisted: false,
      error: durabilityError,
    });
    channelTraceMocks.warn.mockClear();

    try {
      seedStreamStatusForTest(streamStatus, streamId, STREAM_PHASE.RUNNING);

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
        type: 'result',
        outcome: RUN_OUTCOME.FAILED,
        executionId,
      });
      await expect(handle.result).resolves.toBe(event);
      expect(untrack).toHaveBeenCalledExactlyOnceWith(executionId);
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.FAILED);
      expect(channelTraceMocks.warn).toHaveBeenCalledExactlyOnceWith(
        'Failed to finalize durable execution state',
        {
          data: {
            agentIdentifier: 'test-agent',
            executionId,
            stage: 'terminal-status',
            terminalStatusPersisted: false,
            error: durabilityError,
          },
        },
      );
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });
});
