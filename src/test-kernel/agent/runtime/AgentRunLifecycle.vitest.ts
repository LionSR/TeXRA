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
import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentProposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import {
  StreamStatusMachine,
  StreamStatusService,
} from '@agent/runtime/StreamStatusService';
import {
  SharedExecutionRegistry,
  type AgentExecutionHandle,
} from '@agent/runtime/executionRegistry';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { AgentFlowError } from '@agent/runtime/AgentFlowResult';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { RetryRequestCoordinatorImpl } from '@agent/runtime/RetryRequestCoordinator';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import {
  EXECUTION_STATUS,
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_STATUS,
  type ExecutionId,
  type StorageKey,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { agentKey } from '@shared/schemas/agent';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { createRecordingHost } from '../progressTestUtils';

const storageMocks = vi.hoisted(() => ({
  writeTerminalStatus: vi.fn().mockResolvedValue(undefined),
  deleteFlowRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: storageMocks.writeTerminalStatus,
  getExecutionStore: () => ({ delete: storageMocks.deleteFlowRecord }),
}));

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
  streamStatus,
  agent = 'test-agent',
}: {
  executionId: ExecutionId;
  streamId: StreamTabId;
  streamStatus: StreamStatusMachine;
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
    streamId,
    executionId,
    runtimeHost: explicit.host,
    session: defaultSession(),
    streamStatus,
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
    coordinators: {
      plan: new PlanApprovalCoordinator(explicit.host),
      proposal: new AgentProposalCoordinator(explicit.host),
      retry: new RetryRequestCoordinatorImpl(explicit.host),
    },
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
  const streamStatus = new StreamStatusMachine();
  const { ctx, explicit } = createLifecycleContext({
    executionId,
    streamId,
    streamStatus,
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

  it('finalizes the stream status owner from the launch context', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-status-owner',
    );

    try {
      seedStreamStatusForTest(
        StreamStatusService,
        streamId,
        STREAM_STATUS.WAITING,
      );

      // The lifecycle owns the whole transition (RUNNING on entry, terminal
      // on exit) against the ctx-owned registry; the module-global
      // StreamStatusService must stay untouched.
      await runFlowWithLifecycle(ctx, async () => ({
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId,
        streamId,
      }));

      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.COMPLETED);
      expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.WAITING);
    } finally {
      clearStreamStatusForTest(streamStatus, streamId);
      clearStreamStatusForTest(StreamStatusService, streamId);
    }
  });

  it('emits run config before the RUNNING status projection', async () => {
    const { executionId, streamId, streamStatus, ctx, explicit } =
      lifecycleFixture('lifecycle-run-config-before-running');

    try {
      await runFlowWithLifecycle(ctx, async () => ({
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId,
        streamId,
      }));

      const setTaskStateIndex = explicit.events.findIndex(
        (event) => event.event === 'setTaskState',
      );
      const runningIndex = explicit.events.findIndex((event) => {
        if (event.event !== 'updateStreamStatus') return false;
        const payload = event.payload as {
          streamId: StreamTabId;
          status: StreamPhase;
        };
        return (
          payload.streamId === streamId &&
          payload.status === STREAM_PHASE.RUNNING
        );
      });

      expect(setTaskStateIndex).toBeGreaterThanOrEqual(0);
      expect(runningIndex).toBeGreaterThanOrEqual(0);
      expect(setTaskStateIndex).toBeLessThan(runningIndex);
    } finally {
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
      expect(SharedExecutionRegistry.getHandle(executionId)).toBeDefined();
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
      expect(SharedExecutionRegistry.getHandle(executionId)).toBeUndefined();
    } finally {
      SharedExecutionRegistry.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('keeps native subagent WAITING results registered and nonterminal', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'lifecycle-subagent-waiting',
    );
    const onCompleted = vi.fn();
    const onError = vi.fn();
    storageMocks.writeTerminalStatus.mockClear();

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
        { isSubagent: true, onCompleted, onError },
      );

      expect(result.outcome).toBe(STREAM_PHASE.WAITING);
      expect(storageMocks.writeTerminalStatus).not.toHaveBeenCalled();
      expect(onCompleted).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(streamStatus.get(streamId)).toBe(STREAM_PHASE.WAITING);
      expect(SharedExecutionRegistry.getHandle(executionId)).toBeDefined();
    } finally {
      SharedExecutionRegistry.untrack(executionId);
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
      // Simulate onBeforeWaiting pre-registering on a turn that then
      // continues past the wait (queued follow-up) and completes normally.
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
      SharedExecutionRegistry.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });

  it('lets a stop/kill tear down a subagent suspended at WAITING (issue #7287)', async () => {
    const { executionId, streamId, ctx } = lifecycleFixture(
      'lifecycle-subagent-waiting-kill',
    );
    const followUpsRelease = vi.spyOn(ctx.session.followUps, 'release');
    const parentStageEnd = vi.spyOn(ctx.parentStage, 'end');
    storageMocks.deleteFlowRecord.mockClear();

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
      expect(SharedExecutionRegistry.getHandle(executionId)).toBeDefined();
      expect(followUpsRelease).not.toHaveBeenCalled();
      expect(storageMocks.deleteFlowRecord).not.toHaveBeenCalled();
      // The fixture's ctx.logger is noopTrace, and the run handle carries it
      // as its trace channel.
      const traceEmit = vi.spyOn(noopTrace, 'emit');

      // runToolUseFlow's finally unregisters this stream's interrupt but
      // (post #7286) preserves the follow-up queue for WAITING — it does not
      // dispose the session — by the time a native subagent suspends at
      // WAITING (not reproduced by this fake runner, but true in production —
      // see runToolUseFlow.ts). Before the fix, SharedExecutionRegistry.kill()
      // found no interruptible context for a suspended handle and silently
      // no-opped, leaving the handle stuck registered forever. It must now
      // fall back to the waiting-cleanup registered above and actually tear
      // the execution down.
      expect(SharedExecutionRegistry.kill(executionId)).toBe(true);

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

      expect(SharedExecutionRegistry.getHandle(executionId)).toBeUndefined();
      expect(StreamStatusService.get(streamId)).toBe(STREAM_PHASE.CANCELLED);
      expect(followUpsRelease).toHaveBeenCalledWith(streamId);
      expect(storageMocks.deleteFlowRecord).toHaveBeenCalledWith(
        `flow_${executionId}`,
      );
      // The kill path never resumes, so the per-suspension parent stage must
      // be closed here rather than dangling open forever.
      expect(parentStageEnd).toHaveBeenCalled();
    } finally {
      SharedExecutionRegistry.untrack(executionId);
      clearStreamStatusForTest(StreamStatusService, streamId);
    }
  });

  // The canonical outcome is decided once and projected three ways. This
  // matrix pins the projections for every terminal path — in particular that
  // a user stop (the no-throw `cancelled` exit, the dominant stop path)
  // persists `interrupted` and ends the stage neutral, never as an error.
  it('projects returned outcomes to terminal status, stage end, and stream status', async () => {
    const cases = [
      {
        outcome: RUN_OUTCOME.COMPLETED,
        terminal: EXECUTION_STATUS.COMPLETED,
        stageEnd: 'stopped',
        stream: STREAM_PHASE.COMPLETED,
      },
      {
        outcome: RUN_OUTCOME.CANCELLED,
        terminal: EXECUTION_STATUS.INTERRUPTED,
        stageEnd: 'stopped',
        stream: STREAM_PHASE.CANCELLED,
      },
      {
        outcome: RUN_OUTCOME.FAILED,
        terminal: EXECUTION_STATUS.ERROR,
        stageEnd: 'error',
        stream: STREAM_PHASE.FAILED,
      },
    ] as const;

    for (const expected of cases) {
      const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
        `outcome-${expected.outcome}`,
      );
      const stageEnd = vi.spyOn(ctx.parentStage, 'end');
      storageMocks.writeTerminalStatus.mockClear();

      try {
        const result = await runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse',
          outcome: expected.outcome,
          executionId,
          streamId,
        }));

        expect(result.outcome).toBe(expected.outcome);
        expect(storageMocks.writeTerminalStatus).toHaveBeenCalledWith(
          executionId,
          expected.terminal,
        );
        expect(stageEnd).toHaveBeenCalledWith(expected.stageEnd);
        expect(streamStatus.get(streamId)).toBe(expected.stream);
      } finally {
        clearStreamStatusForTest(streamStatus, streamId);
      }
    }
  });

  it('projects a thrown abort as cancelled (interrupted, neutral stage)', async () => {
    const { executionId, streamId, streamStatus, ctx } = lifecycleFixture(
      'outcome-thrown-abort',
    );
    const stageEnd = vi.spyOn(ctx.parentStage, 'end');
    storageMocks.writeTerminalStatus.mockClear();

    try {
      const result = await runFlowWithLifecycle(ctx, async () => {
        throw new DOMException('Request aborted', 'AbortError');
      });

      expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
      expect(storageMocks.writeTerminalStatus).toHaveBeenCalledWith(
        executionId,
        EXECUTION_STATUS.INTERRUPTED,
      );
      expect(stageEnd).toHaveBeenCalledWith('stopped');
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
    storageMocks.writeTerminalStatus.mockClear();

    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => {
          throw new Error('model exploded');
        }),
      ).rejects.toThrow('model exploded');

      expect(storageMocks.writeTerminalStatus).toHaveBeenCalledWith(
        executionId,
        EXECUTION_STATUS.ERROR,
      );
      expect(stageEnd).toHaveBeenCalledWith('error');
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
      SharedExecutionRegistry.untrack(executionId);
      clearStreamStatusForTest(streamStatus, streamId);
    }
  });
});
