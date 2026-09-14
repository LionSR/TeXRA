import { it } from '@effect/vitest';
import { Effect } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { describe, expect, vi } from 'vitest';

import { TraceEmitter, type ResultEvent } from '@agent/trace';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentRunStateSnapshotSchema,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  fakeProcessServices,
  setupPlatform,
} from '@test/support/setupPlatform';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';
import {
  createTestLaunchContext,
  testModelInfo,
} from './launchContextTestUtils';

let counter = 0;

/** Let the folded `run.end` row reach the session's `onResult` listeners. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

/**
 * The lifecycle program over the fake host's process services. The suite runs
 * it on the default runtime rather than a process runtime, so the services it
 * requires are provided here.
 */
function runFlow(...args: Parameters<typeof runFlowWithLifecycle<never>>) {
  return Effect.provide(runFlowWithLifecycle(...args), fakeProcessServices());
}

/**
 * Fresh logger + launch context, with the run's existence fact published and
 * a collector on the session's terminal rows: the `run.end` row the storage
 * finalizer writes is the run's one terminal fact, and `onResult` is how the
 * runtime hands it to in-process consumers.
 */
function setupResultCase(session?: SessionHandle): {
  logger: TraceEmitter;
  results: ResultEvent[];
  ctx: AgentLaunchContext;
} {
  const logger = new TraceEmitter();
  const n = counter++;
  const runId = `e${n.toString(16).padStart(5, '0')}` as RunId;
  const ctx = createTestLaunchContext({ runId, logger, session });
  const runSession = ctx.runScope.session;
  // A caller that owns the session publishes the existence fact itself, with
  // the parent edge it is exercising.
  if (!session) publishTestRunStart(runSession, runId);
  const results: ResultEvent[] = [];
  runSession.onResult((event) => {
    if (event.runId === runId) results.push(event);
  });
  return { logger, results, ctx };
}

/** The completed tool-use result a flow returns for the given run. */
function completedRun(ctx: AgentLaunchContext): AgentFlowResult {
  return {
    outcome: RUN_OUTCOME.COMPLETED,
    runId: ctx.runScope.runId,
    output: { category: 'toolUse', response: '', files: [] },
  };
}

/** The flow fails with a model failure. */
function explodedRun(): Effect.Effect<never, Error> {
  return Effect.fail(new Error('model exploded'));
}

/** Assert the run emitted exactly one result matching the given fields. */
function expectSingleResult(
  results: ResultEvent[],
  ctx: AgentLaunchContext,
  expected: Record<string, unknown>,
): void {
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    type: 'run.end',
    runId: ctx.runScope.runId,
    ...expected,
  });
}

describe('terminal result event', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
  });

  it.effect('emits exactly one completed result on a successful run', () =>
    Effect.gen(function* () {
      const { ctx, results } = setupResultCase();
      yield* runFlow(ctx, () => Effect.succeed(completedRun(ctx)));
      expectSingleResult(results, ctx, {
        outcome: 'completed',
        output: { category: 'toolUse' },
      });
      expect(results[0].error).toBeUndefined();
    }),
  );

  it.effect.each([
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
  ])('keeps running when onRun $name', ({ onRun }) =>
    Effect.gen(function* () {
      const { ctx, results } = setupResultCase();
      const result = yield* runFlow(
        ctx,
        () => Effect.succeed(completedRun(ctx)),
        { onRun },
      );
      expect(result).toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
      yield* settle;

      expectSingleResult(results, ctx, { outcome: 'completed' });
    }),
  );

  it.effect(
    'keeps the failed subagent result when the onError delivery hook throws',
    () =>
      Effect.gen(function* () {
        const { ctx, results } = setupResultCase();
        const result = yield* runFlow(ctx, explodedRun, {
          parentRunId: generateRunId(),
          onError: () => {
            throw new Error('delivery hook boom');
          },
        });
        expect(result).toMatchObject({ outcome: RUN_OUTCOME.FAILED });

        expectSingleResult(results, ctx, { outcome: 'failed' });
      }),
  );

  it.effect(
    'emits the failed result even if ending the parent stage throws',
    () =>
      Effect.gen(function* () {
        const { ctx, results } = setupResultCase();
        vi.spyOn(ctx.parentStage, 'end').mockImplementation(() => {
          throw new Error('stage listener boom');
        });

        const error = yield* Effect.flip(runFlow(ctx, explodedRun));
        expect(error.message).toContain('model exploded');

        expectSingleResult(results, ctx, { outcome: 'failed' });
      }),
  );

  it.effect(
    'maps a returned cancellation to a cancelled result (sibling of failed)',
    () =>
      Effect.gen(function* () {
        const { ctx, results } = setupResultCase();
        yield* runFlow(ctx, () =>
          Effect.succeed({
            outcome: RUN_OUTCOME.CANCELLED,
            runId: ctx.runScope.runId,
            output: { category: 'toolUse', response: '', files: [] },
          }),
        );
        expectSingleResult(results, ctx, { outcome: 'cancelled' });
      }),
  );

  it.effect('emits a cancelled result with kind=abort on a thrown abort', () =>
    Effect.gen(function* () {
      const { ctx, results } = setupResultCase();
      yield* runFlow(ctx, () =>
        Effect.fail(new DOMException('Request aborted', 'AbortError')),
      );
      expectSingleResult(results, ctx, { outcome: 'cancelled' });
      expect(results[0].error?.kind).toBe('abort');
    }),
  );

  it.effect(
    'emits a failed result with usage on an unexpected throw after a round',
    () =>
      Effect.gen(function* () {
        const { ctx, results } = setupResultCase();
        // Record one round of usage so the failed result still carries totals.
        yield* Effect.promise(() =>
          ctx.usageMonitor.recordUsage(
            AgentRunStateSnapshotSchema.parse({}),
            testModelInfo,
          ),
        );
        const error = yield* Effect.flip(runFlow(ctx, explodedRun));
        expect(error.message).toContain('model exploded');
        expectSingleResult(results, ctx, { outcome: 'failed' });
        expect(results[0].error?.kind).toBeDefined();
        expect(results[0].usage).toBeDefined();
      }),
  );

  it.effect('bridges a child run result to session.onResult', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      const onResult = vi.fn();
      const { logger, ctx } = setupResultCase(session);
      const parentRunId = publishTestRunStart(session);
      publishTestRunStart(session, ctx.runScope.runId, {
        parent: parentRunId,
      });
      const detach = session.attachRunTrace(logger, ctx.runScope.runId);
      session.onResult(onResult);
      try {
        yield* runFlow(ctx, () => Effect.succeed(completedRun(ctx)), {
          parentRunId,
        });
        yield* Effect.promise(() => session.settlePublications());
        expect(onResult).toHaveBeenCalledOnce();
        expect(onResult.mock.calls[0][0]).toMatchObject({
          type: 'run.end',
          runId: ctx.runScope.runId,
          outcome: 'completed',
        });
      } finally {
        detach();
        yield* session.dispose();
      }
    }),
  );
});
