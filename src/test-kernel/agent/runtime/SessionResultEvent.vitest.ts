// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Local imports
import { TraceEmitter, type ResultEvent } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentProposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import { PlanApprovalCoordinator } from '@agent/runtime/PlanApprovalCoordinator';
import { RetryRequestCoordinatorImpl } from '@agent/runtime/RetryRequestCoordinator';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunHandle } from '@agent/runtime/executionRegistry';
import { StreamStatusRegistry } from '@agent/runtime/StreamStatusService';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import {
  RUN_OUTCOME,
  STREAM_STATUS,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { createRecordingHost } from '../progressTestUtils';

const storageMocks = vi.hoisted(() => ({
  writeTerminalStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: storageMocks.writeTerminalStatus,
}));

let counter = 0;

function createCtx(overrides?: { logger?: TraceEmitter }): {
  ctx: AgentLaunchContext;
  streamStatus: StreamStatusRegistry;
} {
  const explicit = createRecordingHost();
  const n = counter++;
  const executionId = `exec:result-${n}` as ExecutionId;
  const streamId = `stream:result-${n}` as StreamTabId;
  const streamStatus = new StreamStatusRegistry();
  const config = AgentConfigSchema.parse({
    agent: 'assistant',
    model: 'test-model',
    agentCategory: AgentCategory.ToolUse,
  });
  const setting = AgentSettingSchema.parse({
    agentCategory: AgentCategory.ToolUse,
  });
  const prompt = AgentPromptSchema.parse({});
  const storageKey = executionId as unknown as StorageKey;
  const logger = overrides?.logger ?? new TraceEmitter();
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
    logger,
    parentStage: logger.openStage('Run: assistant'),
    storageKey,
    userVarChannels: { input: Object.freeze({}), transient: {} },
    attachedMemoryMisses: [],
    usageMonitor: new UsageMonitor(
      modelInfo,
      { logger, runtimeHost: explicit.host, storageKey, streamId },
      { agentName: config.agent, agentCategory: setting.agentCategory },
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
    getActiveChildren: () => ({ subagents: [], processes: [] }),
    waitForRetry: vi.fn(),
  };
  return { ctx, streamStatus };
}

function collectResults(logger: TraceEmitter): ResultEvent[] {
  const results: ResultEvent[] = [];
  logger.subscribe((event) => {
    if (event.type === 'result') results.push(event);
  });
  return results;
}

describe('terminal result event (SDK Step 7d PR 6)', () => {
  beforeAll(async () => {
    const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
      import('@platform/platform'),
      import('@test/support/FakePlatform'),
    ]);
    initPlatform(
      createFakePlatform({
        globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
      }),
    );
  });

  it('emits exactly one completed result on a successful run', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    try {
      await runFlowWithLifecycle(ctx, async () => ({
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId: ctx.executionId,
        streamId: ctx.streamId,
      }));
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        type: 'result',
        outcome: 'completed',
        executionId: ctx.executionId,
        category: 'toolUse',
        isSubagent: false,
      });
      expect(results[0].error).toBeUndefined();
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('emits exactly one completed result even if terminal stream-status cleanup throws', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    // A status subscriber that throws on the terminal (STOPPED) transition, not
    // the initial RUNNING one — models a host emit / status listener throwing
    // during post-completion cleanup. The run already emitted `completed`, so
    // this must NOT re-enter the catch arm and publish a second `failed`.
    const off = streamStatus.onDidChange((change) => {
      if (change.status === STREAM_STATUS.STOPPED) {
        throw new Error('status listener boom');
      }
    });
    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId: ctx.executionId,
          streamId: ctx.streamId,
        })),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe('completed');
    } finally {
      off();
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('emits the completed result even if ending the parent stage throws', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    vi.spyOn(ctx.parentStage, 'end').mockImplementation(() => {
      throw new Error('stage listener boom');
    });

    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId: ctx.executionId,
          streamId: ctx.streamId,
        })),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        outcome: 'completed',
        executionId: ctx.executionId,
      });
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('exposes the per-run handle via onRun and settles handle.result (F-2)', async () => {
    const logger = new TraceEmitter();
    const { ctx, streamStatus } = createCtx({ logger });
    let handle: AgentRunHandle | undefined;
    try {
      await runFlowWithLifecycle(
        ctx,
        async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId: ctx.executionId,
          streamId: ctx.streamId,
        }),
        {
          onRun: (h) => {
            handle = h;
          },
        },
      );
      expect(handle).toBeDefined();
      // The handle carries the run's trace channel for run-scoped subscribers.
      expect(handle?.trace).toBe(logger);
      // `result` settles with the same terminal event (always resolves).
      await expect(handle?.result).resolves.toMatchObject({
        type: 'result',
        outcome: 'completed',
        executionId: ctx.executionId,
      });
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('keeps running when onRun throws synchronously', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    try {
      await expect(
        runFlowWithLifecycle(
          ctx,
          async () => ({
            category: 'toolUse',
            outcome: RUN_OUTCOME.COMPLETED,
            executionId: ctx.executionId,
            streamId: ctx.streamId,
          }),
          {
            onRun: () => {
              throw new Error('onRun boom');
            },
          },
        ),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        type: 'result',
        outcome: 'completed',
        executionId: ctx.executionId,
      });
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('keeps running when onRun rejects asynchronously', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    try {
      await expect(
        runFlowWithLifecycle(
          ctx,
          async () => ({
            category: 'toolUse',
            outcome: RUN_OUTCOME.COMPLETED,
            executionId: ctx.executionId,
            streamId: ctx.streamId,
          }),
          {
            onRun: async () => {
              throw new Error('onRun async boom');
            },
          },
        ),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
      await Promise.resolve();

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        type: 'result',
        outcome: 'completed',
        executionId: ctx.executionId,
      });
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('keeps the completed result when the completion hook throws', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    try {
      await expect(
        runFlowWithLifecycle(
          ctx,
          async () => ({
            category: 'toolUse',
            outcome: RUN_OUTCOME.COMPLETED,
            executionId: ctx.executionId,
            streamId: ctx.streamId,
          }),
          {
            onCompleted: () => {
              throw new Error('delivery hook boom');
            },
          },
        ),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        outcome: 'completed',
        executionId: ctx.executionId,
      });
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('emits the failed result before terminal error status listeners run', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    const off = streamStatus.onDidChange((change) => {
      if (change.status === STREAM_STATUS.ERROR) {
        throw new Error('status listener boom');
      }
    });
    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => {
          throw new Error('model exploded');
        }),
      ).rejects.toThrow('model exploded');

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        outcome: 'failed',
        executionId: ctx.executionId,
      });
    } finally {
      off();
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('emits the failed result even if ending the parent stage throws', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    vi.spyOn(ctx.parentStage, 'end').mockImplementation(() => {
      throw new Error('stage listener boom');
    });

    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => {
          throw new Error('model exploded');
        }),
      ).rejects.toThrow('model exploded');

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        outcome: 'failed',
        executionId: ctx.executionId,
      });
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('settles handle.result as failed on a thrown run (always resolves)', async () => {
    const logger = new TraceEmitter();
    const { ctx, streamStatus } = createCtx({ logger });
    let handle: AgentRunHandle | undefined;
    try {
      await expect(
        runFlowWithLifecycle(
          ctx,
          async () => {
            throw new Error('boom');
          },
          {
            onRun: (h) => {
              handle = h;
            },
          },
        ),
      ).rejects.toThrow('boom');
      await expect(handle?.result).resolves.toMatchObject({
        type: 'result',
        outcome: 'failed',
      });
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('maps a returned cancellation to a cancelled result (sibling of failed)', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    try {
      await runFlowWithLifecycle(ctx, async () => ({
        category: 'toolUse',
        outcome: RUN_OUTCOME.CANCELLED,
        executionId: ctx.executionId,
        streamId: ctx.streamId,
      }));
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe('cancelled');
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('emits a cancelled result with kind=abort on a thrown abort', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    try {
      await runFlowWithLifecycle(ctx, async () => {
        throw new DOMException('Request aborted', 'AbortError');
      });
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe('cancelled');
      expect(results[0].error?.kind).toBe('abort');
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('emits a failed result with usage on an unexpected throw after a round', async () => {
    const logger = new TraceEmitter();
    const results = collectResults(logger);
    const { ctx, streamStatus } = createCtx({ logger });
    // Record one round of usage so the failed result still carries totals.
    await ctx.usageMonitor.recordUsage(AgentRunStateSnapshotSchema.parse({}));
    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => {
          throw new Error('model exploded');
        }),
      ).rejects.toThrow('model exploded');
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe('failed');
      expect(results[0].error?.kind).toBeDefined();
      expect(results[0].usage).toBeDefined();
    } finally {
      streamStatus.clear(ctx.streamId, { emit: false });
    }
  });

  it('marks subagent runs and bridges results to session.onResult', async () => {
    const session = new SessionHandle();
    const logger = new TraceEmitter();
    const onResult = vi.fn();
    const detach = session.attachRunTrace(logger);
    session.onResult(onResult);
    const { ctx, streamStatus } = createCtx({ logger });
    try {
      await runFlowWithLifecycle(
        ctx,
        async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId: ctx.executionId,
          streamId: ctx.streamId,
        }),
        { isSubagent: true },
      );
      expect(onResult).toHaveBeenCalledOnce();
      expect(onResult.mock.calls[0][0]).toMatchObject({
        type: 'result',
        isSubagent: true,
      });
    } finally {
      detach();
      streamStatus.clear(ctx.streamId, { emit: false });
      session.dispose();
    }
  });
});
