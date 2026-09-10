import { Effect } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import { TraceEmitter, type ResultEvent } from '@agent/trace';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import type { AgentRunHandle } from '@agent/runtime/RunHandle';
import { RunStatusMachine } from '@agent/runtime/RunStatusService';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { RUN_OUTCOME, RUN_PHASE, type RunId } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { setupPlatform } from '@test/support/setupPlatform';
import { clearRunStatusForTest } from '@test/support/runStatusTestUtils';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';
import { generateRunId } from '@utils/core';

const storageMocks = vi.hoisted(() => ({
  finalizeRun: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@agent/storage', () => ({
  finalizeRun: storageMocks.finalizeRun,
}));

let counter = 0;

/** Fresh logger + result collector + launch context, wired together. */
function setupResultCase(session?: ReturnType<typeof createTestSession>): {
  logger: TraceEmitter;
  results: ResultEvent[];
  ctx: AgentLaunchContext;
  runStatus: RunStatusMachine;
} {
  const logger = new TraceEmitter();
  const results: ResultEvent[] = [];
  logger.subscribe((event) => {
    if (event.type === 'result') results.push(event);
  });

  const n = counter++;
  const ctx = createTestLaunchContext({
    runId: `e${n.toString(16).padStart(5, '0')}` as RunId,
    logger,
    session,
  });
  return { logger, results, ctx, runStatus: ctx.runScope.session.status };
}

/** The completed tool-use result a flow returns for the given run. */
function completedRun(ctx: AgentLaunchContext) {
  return {
    category: 'toolUse',
    outcome: RUN_OUTCOME.COMPLETED,
    runId: ctx.runScope.runId,
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
    runId: ctx.runScope.runId,
    ...expected,
  });
}

describe('terminal result event', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
  });

  it('emits exactly one completed result on a successful run', async () => {
    const { ctx, runStatus, results } = setupResultCase();
    try {
      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => completedRun(ctx)),
      );
      expectSingleResult(results, ctx, {
        outcome: 'completed',
        category: 'toolUse',
      });
      expect(results[0].error).toBeUndefined();
      // One disposal owner for the run's model handler: the cell closes
      // whichever handler is live when the run ends.
      expect(ctx.modelCell.handler.dispose).toHaveBeenCalledTimes(1);
    } finally {
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
    }
  });

  it('emits the completed result even if ending the parent stage throws', async () => {
    const { ctx, runStatus, results } = setupResultCase();
    vi.spyOn(ctx.parentStage, 'end').mockImplementation(() => {
      throw new Error('stage listener boom');
    });

    try {
      await expect(
        Effect.runPromise(
          runFlowWithLifecycle(ctx, async () => completedRun(ctx)),
        ),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });

      expectSingleResult(results, ctx, { outcome: 'completed' });
    } finally {
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
    }
  });

  it('exposes the per-run handle via onRun and settles handle.result', async () => {
    const { logger, ctx, runStatus } = setupResultCase();
    let handle: AgentRunHandle | undefined;
    try {
      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => completedRun(ctx), {
          onRun: (h) => {
            handle = h;
          },
        }),
      );
      expect(handle).toBeDefined();
      // The handle carries the run's trace channel for run-scoped subscribers.
      expect(handle?.trace).toBe(logger);
      // `result` settles with the same terminal event (always resolves).
      await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
        type: 'result',
        outcome: 'completed',
        runId: ctx.runScope.runId,
      });
    } finally {
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
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
    const { ctx, runStatus, results } = setupResultCase();
    try {
      await expect(
        Effect.runPromise(
          runFlowWithLifecycle(ctx, async () => completedRun(ctx), { onRun }),
        ),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
      await Promise.resolve();

      expectSingleResult(results, ctx, { outcome: 'completed' });
    } finally {
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
    }
  });

  it('keeps the failed subagent result when the onError delivery hook throws', async () => {
    const { ctx, runStatus, results } = setupResultCase();
    try {
      await expect(
        Effect.runPromise(
          runFlowWithLifecycle(ctx, explodedRun, {
            parentRunId: generateRunId(),
            onError: () => {
              throw new Error('delivery hook boom');
            },
          }),
        ),
      ).resolves.toMatchObject({ outcome: RUN_OUTCOME.FAILED });

      expectSingleResult(results, ctx, { outcome: 'failed' });
    } finally {
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
    }
  });

  it('emits the failed result even if ending the parent stage throws', async () => {
    const { ctx, runStatus, results } = setupResultCase();
    vi.spyOn(ctx.parentStage, 'end').mockImplementation(() => {
      throw new Error('stage listener boom');
    });

    try {
      await expect(
        Effect.runPromise(runFlowWithLifecycle(ctx, explodedRun)),
      ).rejects.toThrow('model exploded');

      expectSingleResult(results, ctx, { outcome: 'failed' });
    } finally {
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
    }
  });

  it('settles handle.result as failed on a thrown run (always resolves)', async () => {
    const { ctx, runStatus } = setupResultCase();
    let handle: AgentRunHandle | undefined;
    try {
      await expect(
        Effect.runPromise(
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
        ),
      ).rejects.toThrow('boom');
      await expect(Effect.runPromise(handle!.result)).resolves.toMatchObject({
        type: 'result',
        outcome: 'failed',
      });
    } finally {
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
    }
  });

  it('maps a returned cancellation to a cancelled result (sibling of failed)', async () => {
    const { ctx, runStatus, results } = setupResultCase();
    try {
      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => ({
          category: 'toolUse',
          outcome: RUN_OUTCOME.CANCELLED,
          runId: ctx.runScope.runId,
        })),
      );
      expectSingleResult(results, ctx, { outcome: 'cancelled' });
    } finally {
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
    }
  });

  it('emits a cancelled result with kind=abort on a thrown abort', async () => {
    const { ctx, runStatus, results } = setupResultCase();
    try {
      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => {
          throw new DOMException('Request aborted', 'AbortError');
        }),
      );
      expectSingleResult(results, ctx, { outcome: 'cancelled' });
      expect(results[0].error?.kind).toBe('abort');
    } finally {
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
    }
  });

  it('emits a failed result with usage on an unexpected throw after a round', async () => {
    const { ctx, runStatus, results } = setupResultCase();
    // Record one round of usage so the failed result still carries totals.
    await ctx.usageMonitor.recordUsage(AgentRunStateSnapshotSchema.parse({}));
    try {
      await expect(
        Effect.runPromise(runFlowWithLifecycle(ctx, explodedRun)),
      ).rejects.toThrow('model exploded');
      expectSingleResult(results, ctx, { outcome: 'failed' });
      expect(results[0].error?.kind).toBeDefined();
      expect(results[0].usage).toBeDefined();
    } finally {
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
    }
  });

  it('bridges a child run result to session.onResult', async () => {
    const session = createTestSession();
    const onResult = vi.fn();
    const { logger, ctx, runStatus } = setupResultCase(session);
    const parentRunId = publishTestRunStart(session);
    publishTestRunStart(session, ctx.runScope.runId, { parent: parentRunId });
    const detach = session.attachRunTrace(logger, ctx.runScope.runId);
    session.onResult(onResult);
    try {
      await Effect.runPromise(
        runFlowWithLifecycle(ctx, async () => completedRun(ctx), {
          parentRunId,
        }),
      );
      await session.settlePublications();
      expect(onResult).toHaveBeenCalledOnce();
      expect(onResult.mock.calls[0][0]).toMatchObject({
        type: 'result',
        runId: ctx.runScope.runId,
        outcome: 'completed',
      });
    } finally {
      detach();
      clearRunStatusForTest(runStatus, ctx.runScope.runId);
      session.dispose();
    }
  });
});
