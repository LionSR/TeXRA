import { it } from '@effect/vitest';
import { Effect } from 'effect';
import '@test/support/defaultSessionTestSetup';

import { describe, expect, vi } from 'vitest';

import { TraceEmitter, type ResultEvent } from '@agent/trace';
import { runWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { Runs } from '@agent/runtime/runRegistry';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { qualifyAggregateId, type RunId } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  fakeProcessServices,
  setupPlatform,
} from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
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

/** The flow fails with a model failure. */
function explodedRun(): Effect.Effect<never, Error> {
  return Effect.fail(new Error('model exploded'));
}

/** The run's committed `run.end` rows, as results. */
const resultsOf = (ctx: AgentLaunchContext) =>
  Effect.gen(function* () {
    yield* ctx.session.log.settled;
    const rows = yield* ctx.session.log.rows(
      qualifyAggregateId('run', ctx.runId),
      ['run.end'],
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
});
