import { it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { describe, expect, vi } from 'vitest';

import { TraceEmitter, type ResultEvent } from '@agent/trace';
import { runWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { Runs } from '@agent/runtime/runRegistry';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import { aggregateId, RUN_OUTCOME, type RunId } from '@shared/schemas';
import { LaunchSurfaceSchema } from '@shared/session/surface';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  fakeProcessServices,
  setupPlatform,
} from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  launchApprovalOptions,
  launchOnRun,
} from '@texra/controllers/mainView/backend/MainViewRunLaunchController';
import { createTestLaunchContext } from './launchContextTestUtils';

let counter = 0;

/**
 * The lifecycle program over the fake host's process services. The suite runs
 * it on the default runtime rather than a process runtime, so the services it
 * requires are provided here.
 */
function runLifecycle(...args: Parameters<typeof runWithLifecycle<never>>) {
  return runWithLifecycle(...args).pipe(
    Effect.provide(fakeProcessServices()),
    Effect.provideService(Runs, args[0].session.runs),
  );
}

/**
 * Fresh logger + launch context, with the run's existence fact published:
 * the `run.end` row the storage finalizer writes is the run's one terminal
 * fact ({@link resultsOf} reads it back).
 */
function setupResultCase(): {
  logger: TraceEmitter;
  ctx: AgentLaunchContext;
} {
  const n = counter++;
  const runId = `e${n.toString(16).padStart(5, '0')}` as RunId;
  const logger = new TraceEmitter();
  const ctx = createTestLaunchContext({ runId, logger });
  publishTestRunStart(ctx.session, runId);
  return { logger, ctx };
}

/** The completed tool-use result a flow returns for the given run. */
function completedRun(ctx: AgentLaunchContext): RunEndResult {
  return {
    outcome: RUN_OUTCOME.COMPLETED,
    runId: ctx.runId,
    output: { response: '', files: [] },
  };
}

/** The flow fails with a model failure. */
function explodedRun(): Effect.Effect<never, Error> {
  return Effect.fail(new Error('model exploded'));
}

/** The run's committed `run.end` rows, as results. */
const resultsOf = (ctx: AgentLaunchContext) =>
  Effect.gen(function* () {
    yield* ctx.session.settlePublications();
    const rows = yield* Stream.runCollect(
      ctx.session.events.aggregate(aggregateId('run', ctx.runId), 0),
    );
    return rows.flatMap((row): ResultEvent[] =>
      row.type === 'run.end' ? [{ ...row, runId: ctx.runId }] : [],
    );
  });

/** Assert the run emitted exactly one result matching the given fields. */
const expectSingleResult = (
  ctx: AgentLaunchContext,
  expected: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const results = yield* resultsOf(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'run.end',
      runId: ctx.runId,
      ...expected,
    });
    return results[0];
  });

describe('terminal result event', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
  });

  it.effect('emits exactly one completed result on a successful run', () =>
    Effect.gen(function* () {
      const { ctx } = setupResultCase();
      yield* runLifecycle(ctx, () => Effect.succeed(completedRun(ctx)));
      const result = yield* expectSingleResult(ctx, {
        outcome: 'completed',
      });
      expect(result.error).toBeUndefined();
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
      const { ctx } = setupResultCase();
      const result = yield* runLifecycle(
        ctx,
        () => Effect.succeed(completedRun(ctx)),
        { onRun },
      );
      expect(result).toMatchObject({ outcome: RUN_OUTCOME.COMPLETED });
      yield* expectSingleResult(ctx, { outcome: 'completed' });
    }),
  );

  // The launch-time approval choice rides on onRun: it must be in force
  // before the run's first step, or an approval could open ahead of it.
  it.effect('an Auto-approve launch is bypassed before the run starts', () =>
    Effect.gen(function* () {
      const { ctx } = setupResultCase();
      const { approvals } = ctx.session;
      const launch = LaunchSurfaceSchema.parse({ approval: 'autoApprove' });
      let atFirstStep: ReturnType<typeof approvals.bypassesFor> | undefined;
      yield* runLifecycle(
        ctx,
        () =>
          Effect.sync(() => {
            atFirstStep = approvals.bypassesFor(ctx.runId);
            return completedRun(ctx);
          }),
        {
          onRun: launchOnRun(
            approvals,
            launchApprovalOptions({ kind: 'launch', launch, instruction: '' }),
          ),
        },
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
        const { ctx } = setupResultCase();
        vi.spyOn(ctx.parentStage, 'end').mockImplementation(() => {
          throw new Error('stage listener boom');
        });

        const error = yield* Effect.flip(runLifecycle(ctx, explodedRun));
        expect(error.message).toContain('model exploded');

        yield* expectSingleResult(ctx, { outcome: 'failed' });
      }),
  );

  it.effect(
    'maps a returned cancellation to a cancelled result (sibling of failed)',
    () =>
      Effect.gen(function* () {
        const { ctx } = setupResultCase();
        yield* runLifecycle(ctx, () =>
          Effect.succeed({
            outcome: RUN_OUTCOME.CANCELLED,
            runId: ctx.runId,
            output: { response: '', files: [] },
          }),
        );
        yield* expectSingleResult(ctx, { outcome: 'cancelled' });
      }),
  );

  it.effect('emits a cancelled result with kind=abort on a thrown abort', () =>
    Effect.gen(function* () {
      const { ctx } = setupResultCase();
      yield* runLifecycle(ctx, () =>
        Effect.fail(new DOMException('Request aborted', 'AbortError')),
      );
      const result = yield* expectSingleResult(ctx, { outcome: 'cancelled' });
      expect(result.error?.kind).toBe('abort');
    }),
  );
});
