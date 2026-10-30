import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';

import { afterEach, describe, expect, vi } from 'vitest';
import { Runs } from '@agent/runtime/runRegistry';

import { SessionHandle } from '@agent/runtime/SessionHandle';
import { runWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { type RunReport } from '@agent/runtime/runReport';
import type { RunLaunch } from '@agent/runtime/run/AgentRun';
import { setLogSink } from '@logger/logSink';
import { qualifyAggregateId, RUN_OUTCOME } from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { startAwaited } from '@test/support/runHandleFixtures';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { fakeProcessServices } from '@test/support/setupPlatform';

import { eventsOfType, recordSessionEvents } from '../progressTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

/** The run's committed `run.end` rows, once the session's writes settled:
 *  what the lifecycle's one terminal writer (`finalizeRun`) said. */
const runEnds = (session: SessionHandle, runId: RunId) =>
  Effect.andThen(
    session.log.settled,
    session.log.rows(qualifyAggregateId('run', runId), ['run.end']),
  );

afterEach(() => {
  setLogSink(null);
  vi.restoreAllMocks();
});

let lifecycleFixtureCounter = 0;

function lifecycleFixture(agent = 'test-agent'): {
  runId: RunId;
  ctx: RunLaunch;
} {
  const runId =
    `e${(lifecycleFixtureCounter++).toString(16).padStart(5, '0')}` as RunId;
  const ctx = createTestLaunchContext({ runId, agent });
  // A run is registered before its lifecycle runs: an activation commits
  // onto the run's rows.
  publishTestRunStart(ctx.session, runId);
  return { runId, ctx };
}

/** The launching run a subagent fixture names as its parent edge. */
const PARENT_RUN_ID = 'aa0001' as RunId;

/**
 * Park the run's terminal before its `run.end` write: its stage end, the
 * terminal's first step, enqueues a job that holds the session's publisher
 * until `release`, so the end's transaction queues behind it. `started`
 * resolves once that job holds the publisher.
 */
const parkTerminal = (ctx: RunLaunch) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const endStage = ctx.parentStage.end.bind(ctx.parentStage);
    vi.spyOn(ctx.parentStage, 'end').mockImplementationOnce((outcome) => {
      Effect.runFork(
        ctx.session.log.transact(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        ),
      );
      endStage(outcome);
    });
    return { started, release };
  });

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

describe('runWithLifecycle', () => {
  it.effect(
    'does not let a stop abandon a run that completes without suspending',
    () =>
      Effect.gen(function* () {
        // The window a stop could once fall into: the run has returned, its live
        // interrupt context is detached, and its own finalize is parked at the
        // persist await. The terminal is masked, so the stop its launch takes
        // lands after the end the run reported.
        const { runId, ctx } = lifecycleFixture();
        const parked = yield* parkTerminal(ctx);

        const running = yield* Effect.forkChild(
          startAwaited(
            ctx.session.runs,
            runId,
            runLifecycle(
              { ...ctx, entry: { ...ctx.entry, parent: PARENT_RUN_ID } },
              () =>
                Effect.succeed({
                  outcome: RUN_OUTCOME.COMPLETED,
                  runId,
                  output: { response: '', files: [] },
                } satisfies RunReport),
            ),
          ),
        );
        // The run reached its own terminal and parked before its persist,
        // which is the window the stop below has to land in.
        yield* Deferred.await(parked.started);

        const stop = testDefaultSession().runs.stop(runId, {
          reason: 'user',
          detachActiveChildren: false,
        });
        expect(stop.accepted()).toBe(true);
        yield* stop.settlement;

        yield* Deferred.succeed(parked.release, undefined);
        yield* Fiber.await(running);
        expect(yield* runEnds(ctx.session, runId)).toMatchObject([
          { outcome: RUN_OUTCOME.COMPLETED },
        ]);
      }),
  );

  // A run that aborts before its first turn is this run's outcome: the run
  // never runs a turn, and the only fact it leaves is the cancelled terminal
  // row with the abort's own error facts on it.
  it.effect(
    'writes the cancelled terminal fact when the run aborts before its first turn',
    () =>
      Effect.gen(function* () {
        const { runId, ctx } = lifecycleFixture();
        const recorded = recordSessionEvents(ctx.session, {
          aggregateId: qualifyAggregateId('run', runId),
        });

        yield* runLifecycle(ctx, () =>
          Effect.fail(new DOMException('Request aborted', 'AbortError')),
        );
        yield* ctx.session.log.settled;
        // A run that never ran a turn writes no step of its own: `run.end` is
        // the whole of what it says.
        expect(
          eventsOfType(
            yield* Effect.promise(() => recorded.read()),
            'run.position',
          ),
        ).toEqual([]);
        expect(yield* runEnds(ctx.session, runId)).toMatchObject([
          {
            outcome: RUN_OUTCOME.CANCELLED,
            error: { kind: 'abort', userRetryable: false },
            output: { response: '', files: [] },
          },
        ]);
      }),
  );
});
