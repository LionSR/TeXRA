// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Test support imports
import { createTestSession } from '@test/support/sessionTestUtils';

// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { clearStreamStatusForTest } from '@test/helpers/streamStatusTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { TraceEmitter, type ResultEvent } from '@agent/trace';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { createRunScope } from '@agent/runtime/RunScope';
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunHandle } from '@agent/runtime/executionRegistry';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
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
  streamStatus: StreamStatusMachine;
} {
  const explicit = createRecordingHost();
  const n = counter++;
  const executionId = `a${n.toString(16).padStart(5, '0')}` as ExecutionId;
  const streamId = `stream:result-${n}` as StreamTabId;
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
  const session = defaultSession();
  const streamStatus = session.status;
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

/** Fresh logger + result collector + launch context, wired together. */
function setupResultCase(): {
  logger: TraceEmitter;
  results: ResultEvent[];
  ctx: AgentLaunchContext;
  streamStatus: StreamStatusMachine;
} {
  const logger = new TraceEmitter();
  const results = collectResults(logger);
  const { ctx, streamStatus } = createCtx({ logger });
  return { logger, results, ctx, streamStatus };
}

describe('terminal result event (SDK Step 7d PR 6)', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
  });

  it('emits exactly one completed result on a successful run', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    try {
      await runFlowWithLifecycle(ctx, async () => ({
        category: 'toolUse',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId: ctx.runScope.executionId,
        streamId: ctx.runScope.streamId,
      }));
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        type: 'result',
        outcome: 'completed',
        executionId: ctx.runScope.executionId,
        category: 'toolUse',
        isSubagent: false,
      });
      expect(results[0].error).toBeUndefined();
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('emits exactly one completed result even if terminal stream-status cleanup throws', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    // A status subscriber that throws on the terminal (COMPLETED) transition,
    // not the initial RUNNING one — models a host emit / status listener throwing
    // during post-completion cleanup. The run already emitted `completed`, so
    // this must NOT re-enter the catch arm and publish a second `failed`.
    const off = streamStatus.onDidChange((change) => {
      if (change.status === STREAM_PHASE.COMPLETED) {
        throw new Error('status listener boom');
      }
    });
    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId: ctx.runScope.executionId,
          streamId: ctx.runScope.streamId,
        })),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe('completed');
    } finally {
      off();
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('emits the completed result even if ending the parent stage throws', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    vi.spyOn(ctx.parentStage, 'end').mockImplementation(() => {
      throw new Error('stage listener boom');
    });

    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId: ctx.runScope.executionId,
          streamId: ctx.runScope.streamId,
        })),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        outcome: 'completed',
        executionId: ctx.runScope.executionId,
      });
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('exposes the per-run handle via onRun and settles handle.result (F-2)', async () => {
    const { logger, ctx, streamStatus } = setupResultCase();
    let handle: AgentRunHandle | undefined;
    try {
      await runFlowWithLifecycle(
        ctx,
        async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId: ctx.runScope.executionId,
          streamId: ctx.runScope.streamId,
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
        executionId: ctx.runScope.executionId,
      });
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('keeps running when onRun throws synchronously', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    try {
      await expect(
        runFlowWithLifecycle(
          ctx,
          async () => ({
            category: 'toolUse',
            outcome: RUN_OUTCOME.COMPLETED,
            executionId: ctx.runScope.executionId,
            streamId: ctx.runScope.streamId,
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
        executionId: ctx.runScope.executionId,
      });
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('keeps running when onRun rejects asynchronously', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    try {
      await expect(
        runFlowWithLifecycle(
          ctx,
          async () => ({
            category: 'toolUse',
            outcome: RUN_OUTCOME.COMPLETED,
            executionId: ctx.runScope.executionId,
            streamId: ctx.runScope.streamId,
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
        executionId: ctx.runScope.executionId,
      });
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('keeps the failed subagent result when the onError delivery hook throws', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    try {
      await expect(
        runFlowWithLifecycle(
          ctx,
          async () => {
            throw new Error('model exploded');
          },
          {
            isSubagent: true,
            onError: () => {
              throw new Error('delivery hook boom');
            },
          },
        ),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.FAILED });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        outcome: 'failed',
        executionId: ctx.runScope.executionId,
      });
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('emits the failed result before terminal error status listeners run', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    const off = streamStatus.onDidChange((change) => {
      if (change.status === STREAM_PHASE.FAILED) {
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
        executionId: ctx.runScope.executionId,
      });
    } finally {
      off();
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('emits the failed result even if ending the parent stage throws', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
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
        executionId: ctx.runScope.executionId,
      });
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('settles handle.result as failed on a thrown run (always resolves)', async () => {
    const { ctx, streamStatus } = setupResultCase();
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
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('maps a returned cancellation to a cancelled result (sibling of failed)', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    try {
      await runFlowWithLifecycle(ctx, async () => ({
        category: 'toolUse',
        outcome: RUN_OUTCOME.CANCELLED,
        executionId: ctx.runScope.executionId,
        streamId: ctx.runScope.streamId,
      }));
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe('cancelled');
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('emits a cancelled result with kind=abort on a thrown abort', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    try {
      await runFlowWithLifecycle(ctx, async () => {
        throw new DOMException('Request aborted', 'AbortError');
      });
      expect(results).toHaveLength(1);
      expect(results[0].outcome).toBe('cancelled');
      expect(results[0].error?.kind).toBe('abort');
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('emits a failed result with usage on an unexpected throw after a round', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
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
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('marks subagent runs and bridges results to session.onResult', async () => {
    const session = createTestSession();
    const logger = new TraceEmitter();
    const onResult = vi.fn();
    const { ctx, streamStatus } = createCtx({ logger });
    const detach = session.attachRunTrace(logger, ctx.runScope.streamId);
    session.onResult(onResult);
    try {
      await runFlowWithLifecycle(
        ctx,
        async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.COMPLETED,
          executionId: ctx.runScope.executionId,
          streamId: ctx.runScope.streamId,
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
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
      session.dispose();
    }
  });
});
