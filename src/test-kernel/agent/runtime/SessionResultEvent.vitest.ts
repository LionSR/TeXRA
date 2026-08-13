import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import { TraceEmitter, type ResultEvent } from '@agent/trace';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import type { AgentRunHandle } from '@agent/runtime/ExecutionHandle';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { setupPlatform } from '@test/support/setupPlatform';
import { clearStreamStatusForTest } from '@test/support/streamStatusTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

const storageMocks = vi.hoisted(() => ({
  finalizeExecution: vi.fn().mockResolvedValue({
    status: 'durable',
    terminalStatusPersisted: true,
    flowRecord: 'deleted',
  }),
}));

vi.mock('@agent/storage', () => ({
  finalizeExecution: storageMocks.finalizeExecution,
}));

let counter = 0;

/** Fresh logger + result collector + launch context, wired together. */
function setupResultCase(): {
  logger: TraceEmitter;
  results: ResultEvent[];
  ctx: AgentLaunchContext;
  streamStatus: StreamStatusMachine;
} {
  const logger = new TraceEmitter();
  const results: ResultEvent[] = [];
  logger.subscribe((event) => {
    if (event.type === 'result') results.push(event);
  });

  const n = counter++;
  const ctx = createTestLaunchContext({
    executionId: `exec:result-${n}` as ExecutionId,
    streamId: `stream:result-${n}` as StreamTabId,
    logger,
  });
  return { logger, results, ctx, streamStatus: ctx.runScope.session.status };
}

/** The completed tool-use result a flow returns for the given run. */
function completedRun(ctx: AgentLaunchContext) {
  return {
    category: 'toolUse',
    outcome: RUN_OUTCOME.COMPLETED,
    executionId: ctx.runScope.executionId,
    streamId: ctx.runScope.streamId,
  } as const;
}

/** The flow throws a model failure. */
async function explodedRun(): Promise<never> {
  throw new Error('model exploded');
}

/** Assert the run emitted exactly one result matching the given fields. */
function expectSingleResult(
  results: ResultEvent[],
  ctx: AgentLaunchContext,
  expected: Record<string, unknown>,
): void {
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    type: 'result',
    executionId: ctx.runScope.executionId,
    ...expected,
  });
}

describe('terminal result event', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
  });

  it('emits exactly one completed result on a successful run', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    try {
      await runFlowWithLifecycle(ctx, async () => completedRun(ctx));
      expectSingleResult(results, ctx, {
        outcome: 'completed',
        category: 'toolUse',
        isSubagent: false,
      });
      expect(results[0].error).toBeUndefined();
      // One disposal owner for the run's model handler: the cell closes
      // whichever handler is live when the run ends.
      expect(ctx.modelCell.handler.dispose).toHaveBeenCalledTimes(1);
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('emits exactly one completed result even if terminal stream-status cleanup throws', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    // A status subscriber that throws on the terminal (COMPLETED) transition,
    // not the initial RUNNING one. The hub isolates subscribers, so the run's
    // completed result remains the sole terminal result.
    const off = ctx.runScope.session.events.subscribeStatus(({ phase }) => {
      if (phase === STREAM_PHASE.COMPLETED) {
        throw new Error('status subscriber boom');
      }
    });
    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => completedRun(ctx)),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
      expectSingleResult(results, ctx, { outcome: 'completed' });
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
        runFlowWithLifecycle(ctx, async () => completedRun(ctx)),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });

      expectSingleResult(results, ctx, { outcome: 'completed' });
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('exposes the per-run handle via onRun and settles handle.result', async () => {
    const { logger, ctx, streamStatus } = setupResultCase();
    let handle: AgentRunHandle | undefined;
    try {
      await runFlowWithLifecycle(ctx, async () => completedRun(ctx), {
        onRun: (h) => {
          handle = h;
        },
      });
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

  it.each([
    {
      name: 'throws synchronously',
      onRun: () => {
        throw new Error('onRun boom');
      },
    },
    {
      name: 'rejects asynchronously',
      onRun: async () => {
        throw new Error('onRun async boom');
      },
    },
  ])('keeps running when onRun $name', async ({ onRun }) => {
    const { ctx, streamStatus, results } = setupResultCase();
    try {
      await expect(
        runFlowWithLifecycle(ctx, async () => completedRun(ctx), { onRun }),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
      await Promise.resolve();

      expectSingleResult(results, ctx, { outcome: 'completed' });
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('keeps the failed subagent result when the onError delivery hook throws', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    try {
      await expect(
        runFlowWithLifecycle(ctx, explodedRun, {
          isSubagent: true,
          onError: () => {
            throw new Error('delivery hook boom');
          },
        }),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.FAILED });

      expectSingleResult(results, ctx, { outcome: 'failed' });
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('emits the failed result before terminal error status subscribers run', async () => {
    const { ctx, streamStatus, results } = setupResultCase();
    const off = ctx.runScope.session.events.subscribeStatus(({ phase }) => {
      if (phase === STREAM_PHASE.FAILED) {
        throw new Error('status subscriber boom');
      }
    });
    try {
      await expect(runFlowWithLifecycle(ctx, explodedRun)).rejects.toThrow(
        'model exploded',
      );

      expectSingleResult(results, ctx, { outcome: 'failed' });
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
      await expect(runFlowWithLifecycle(ctx, explodedRun)).rejects.toThrow(
        'model exploded',
      );

      expectSingleResult(results, ctx, { outcome: 'failed' });
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
      expectSingleResult(results, ctx, { outcome: 'cancelled' });
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
      expectSingleResult(results, ctx, { outcome: 'cancelled' });
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
      await expect(runFlowWithLifecycle(ctx, explodedRun)).rejects.toThrow(
        'model exploded',
      );
      expectSingleResult(results, ctx, { outcome: 'failed' });
      expect(results[0].error?.kind).toBeDefined();
      expect(results[0].usage).toBeDefined();
    } finally {
      clearStreamStatusForTest(streamStatus, ctx.runScope.streamId);
    }
  });

  it('marks subagent runs and bridges results to session.onResult', async () => {
    const session = createTestSession();
    const onResult = vi.fn();
    const { logger, ctx, streamStatus } = setupResultCase();
    const detach = session.attachRunTrace(logger, ctx.runScope.streamId);
    session.onResult(onResult);
    try {
      await runFlowWithLifecycle(ctx, async () => completedRun(ctx), {
        isSubagent: true,
      });
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
