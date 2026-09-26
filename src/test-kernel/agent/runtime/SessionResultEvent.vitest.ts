import { it } from '@effect/vitest';
import { Effect } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { describe, expect, vi } from 'vitest';

import { TraceEmitter, type ResultEvent } from '@agent/trace';
import { runFlowWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { Runs } from '@agent/runtime/runRegistry';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { launchAutonomyOptions } from '@controllers/mainView/backend/MainViewRunLaunchController';
import { RUN_OUTCOME, type RunId } from '@shared/schemas';
import { LaunchSurfaceSchema } from '@shared/session/surface';
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
import { createTestLaunchContext } from './launchContextTestUtils';

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
  return runFlowWithLifecycle(...args).pipe(
    Effect.provide(fakeProcessServices()),
    Effect.provideService(Runs, args[0].session.runs),
  );
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
  const runSession = ctx.session;
  // A caller that owns the session publishes the existence fact itself, with
  // the parent edge it is exercising.
  if (!session) publishTestRunStart(runSession, runId);
  const results: ResultEvent[] = [];
  runSession.onResult((event) =>
    Effect.sync(() => {
      if (event.runId === runId) results.push(event);
    }),
  );
  return { logger, results, ctx };
}

/** The completed tool-use result a flow returns for the given run. */
function completedRun(ctx: AgentLaunchContext): AgentFlowResult {
  return {
    outcome: RUN_OUTCOME.COMPLETED,
    runId: ctx.runId,
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
    runId: ctx.runId,
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
      name: 'throws while building its program',
      onRun: () => {
        throw new Error('onRun boom');
      },
    },
    {
      name: 'fails',
      onRun: () => Effect.fail(new Error('onRun failure boom')),
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

  // The launch-time autonomy choice rides on onRun: it must be in force
  // before the run's first step, or an approval could open ahead of it.
  it.effect('an Autonomous launch is bypassed before the run starts', () =>
    Effect.gen(function* () {
      const { ctx } = setupResultCase();
      const { approvals } = ctx.session;
      const launch = LaunchSurfaceSchema.parse({ autonomy: 'autonomous' });
      let atFirstStep: ReturnType<typeof approvals.bypassesFor> | undefined;
      yield* runFlow(
        ctx,
        () =>
          Effect.sync(() => {
            atFirstStep = approvals.bypassesFor(ctx.runId);
            return completedRun(ctx);
          }),
        launchAutonomyOptions(
          { kind: 'launch', launch, instruction: '' },
          approvals,
        ),
      );
      expect(atFirstStep).toEqual({
        bash: true,
        toolEdit: true,
        superYolo: true,
      });
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
            runId: ctx.runId,
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

  it.effect('bridges a child run result to session.onResult', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      const onResult = vi.fn((_event: ResultEvent) => Effect.void);
      const { logger, ctx } = setupResultCase(session);
      const parentRunId = publishTestRunStart(session);
      publishTestRunStart(session, ctx.runId, {
        parent: parentRunId,
      });
      const detach = session.attachRunTrace(logger, ctx.runId);
      session.onResult(onResult);
      try {
        yield* runFlow(ctx, () => Effect.succeed(completedRun(ctx)), {
          parentRunId,
        });
        yield* session.settlePublications();
        expect(onResult).toHaveBeenCalledOnce();
        expect(onResult.mock.calls[0][0]).toMatchObject({
          type: 'run.end',
          runId: ctx.runId,
          outcome: 'completed',
        });
      } finally {
        detach();
        yield* session.dispose();
      }
    }),
  );
});
