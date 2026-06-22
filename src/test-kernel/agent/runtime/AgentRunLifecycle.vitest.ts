// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports - runtime
import { noopTrace } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentProposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import {
  StreamStatusRegistry,
  StreamStatusService,
} from '@agent/runtime/StreamStatusService';
import { executionRegistry } from '@agent/runtime/executionRegistry';
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
  STREAM_STATUS,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { agentKey } from '@shared/schemas/agent';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { createRecordingHost } from '../progressTestUtils';

const storageMocks = vi.hoisted(() => ({
  writeTerminalStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: storageMocks.writeTerminalStatus,
}));

async function initLifecycleTestPlatform(firstRunDone: boolean) {
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  const fake = createFakePlatform({
    globalState: {
      [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: firstRunDone,
    },
  });
  initPlatform(fake);
  return fake;
}

function createLifecycleContext({
  executionId,
  streamId,
  streamStatus,
  agent = 'test-agent',
}: {
  executionId: ExecutionId;
  streamId: StreamTabId;
  streamStatus: StreamStatusRegistry;
  agent?: string;
}): AgentLaunchContext {
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

  return {
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
    bestConnectionMethod: vi.fn().mockResolvedValue({ connector: ' ', choice: 'B' }),
    coordinators: {
      plan: new PlanApprovalCoordinator(explicit.host),
      proposal: new AgentProposalCoordinator(explicit.host),
      retry: new RetryRequestCoordinatorImpl(explicit.host),
    },
  };
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
      const executionId = `execution-lifecycle-${slug}` as ExecutionId;
      const streamId = `stream-lifecycle-${slug}` as StreamTabId;
      const streamStatus = new StreamStatusRegistry();
      const ctx = createLifecycleContext({
        executionId,
        streamId,
        streamStatus,
        agent,
      });

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
        streamStatus.clear(streamId, { emit: false });
      }
    });
  }

  it('finalizes the stream status owner from the launch context', async () => {
    const executionId = 'execution-lifecycle-status-owner' as ExecutionId;
    const streamId = 'stream-lifecycle-status-owner' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const ctx = createLifecycleContext({
      executionId,
      streamId,
      streamStatus,
    });

    try {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
        emit: false,
      });

      // The lifecycle owns the whole transition (RUNNING on entry, terminal
      // on exit) against the ctx-owned registry; the module-global
      // StreamStatusService must stay untouched.
      await runFlowWithLifecycle(ctx, async () => ({
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId,
        streamId,
      }));

      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.STOPPED);
      expect(StreamStatusService.get(streamId)).toBe(STREAM_STATUS.WAITING);
    } finally {
      streamStatus.clear(streamId, { emit: false });
      StreamStatusService.clear(streamId, { emit: false });
    }
  });

  it('delivers subagent aborts through the terminal callback', async () => {
    const executionId = 'execution-lifecycle-subagent-abort' as ExecutionId;
    const streamId = 'stream-lifecycle-subagent-abort' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const ctx = createLifecycleContext({
      executionId,
      streamId,
      streamStatus,
    });
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
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.STOPPED);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][1]).toEqual(result);
    } finally {
      streamStatus.clear(streamId, { emit: false });
    }
  });

  it('keeps subagent errors registered until terminal delivery runs', async () => {
    const executionId =
      'execution-lifecycle-subagent-error-registered' as ExecutionId;
    const streamId =
      'stream-lifecycle-subagent-error-registered' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const ctx = createLifecycleContext({
      executionId,
      streamId,
      streamStatus,
    });
    const onError = vi.fn(() => {
      expect(executionRegistry.getHandle(executionId)).toBeDefined();
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
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.ERROR);
      expect(onError).toHaveBeenCalledOnce();
      expect(executionRegistry.getHandle(executionId)).toBeUndefined();
    } finally {
      executionRegistry.untrack(executionId);
      streamStatus.clear(streamId, { emit: false });
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
        stream: STREAM_STATUS.STOPPED,
      },
      {
        outcome: RUN_OUTCOME.CANCELLED,
        terminal: EXECUTION_STATUS.INTERRUPTED,
        stageEnd: 'stopped',
        stream: STREAM_STATUS.STOPPED,
      },
      {
        outcome: RUN_OUTCOME.FAILED,
        terminal: EXECUTION_STATUS.ERROR,
        stageEnd: 'error',
        stream: STREAM_STATUS.ERROR,
      },
    ] as const;

    for (const expected of cases) {
      const executionId =
        `execution-outcome-${expected.outcome}` as ExecutionId;
      const streamId = `stream-outcome-${expected.outcome}` as StreamTabId;
      const streamStatus = new StreamStatusRegistry();
      const ctx = createLifecycleContext({
        executionId,
        streamId,
        streamStatus,
      });
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
        streamStatus.clear(streamId, { emit: false });
      }
    }
  });

  it('projects a thrown abort as cancelled (interrupted, neutral stage)', async () => {
    const executionId = 'execution-outcome-thrown-abort' as ExecutionId;
    const streamId = 'stream-outcome-thrown-abort' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const ctx = createLifecycleContext({
      executionId,
      streamId,
      streamStatus,
    });
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
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.STOPPED);
    } finally {
      streamStatus.clear(streamId, { emit: false });
    }
  });

  it('projects an unexpected throw as failed', async () => {
    const executionId = 'execution-outcome-thrown-error' as ExecutionId;
    const streamId = 'stream-outcome-thrown-error' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const ctx = createLifecycleContext({
      executionId,
      streamId,
      streamStatus,
    });
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
      expect(streamStatus.get(streamId)).toBe(STREAM_STATUS.ERROR);
    } finally {
      streamStatus.clear(streamId, { emit: false });
    }
  });

  it('passes flow-carried terminal results to subagent error delivery', async () => {
    const executionId =
      'execution-lifecycle-subagent-flow-error' as ExecutionId;
    const streamId = 'stream-lifecycle-subagent-flow-error' as StreamTabId;
    const streamStatus = new StreamStatusRegistry();
    const ctx = createLifecycleContext({
      executionId,
      streamId,
      streamStatus,
    });
    const carriedResult = {
      category: 'toolUse' as const,
      outcome: RUN_OUTCOME.FAILED,
      executionId,
      streamId,
      totalCostUsd: 0.73,
    };
    const onError = vi.fn();

    try {
      streamStatus.set(streamId, STREAM_STATUS.RUNNING, { emit: false });

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
      executionRegistry.untrack(executionId);
      streamStatus.clear(streamId, { emit: false });
    }
  });
});
