import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';

import { afterEach, describe, expect, vi } from 'vitest';
import { Runs } from '@agent/runtime/runRegistry';

import { SessionHandle } from '@agent/runtime/SessionHandle';
import { runWithLifecycle } from '@agent/runtime/AgentRunLifecycle';
import { type RunEndResult } from '@agent/runtime/RunEndResult';
import type { AgentLaunchContext } from '@agent/runtime/AgentLaunchContext';
import { setLogSink } from '@logger/logSink';
import { qualifyAggregateId, RUN_OUTCOME } from '@shared/schemas';
import type { RunId, RunOutcome } from '@shared/schemas';
import { untrackRun } from '@test/support/sessionEnd';
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
  ctx: AgentLaunchContext;
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

/** What a tool-use run that produced no output ends with on its `run.end`. */
const EMPTY_TOOL_USE_OUTPUT = {
  response: '',
  files: [],
} as const;

function toolUseResult(runId: RunId, outcome: RunOutcome): RunEndResult {
  return { outcome, runId, output: { ...EMPTY_TOOL_USE_OUTPUT, files: [] } };
}

/**
 * Park the run's terminal before its `run.end` write: its stage end, the
 * terminal's first step, enqueues a job that holds the session's publisher
 * until `release`, so the end's transaction queues behind it. `started`
 * resolves once that job holds the publisher.
 */
const parkTerminal = (ctx: AgentLaunchContext) =>
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
        // persist await with the handle still tracked. Only the WAITING branch
        // parks a handle, so there is no suspension for the stop to find and
        // nothing the exit has to remember to clear.
        const { runId, ctx } = lifecycleFixture();
        const parked = yield* parkTerminal(ctx);

        try {
          const running = yield* Effect.forkChild(
            runLifecycle(
              ctx,
              () => Effect.succeed(toolUseResult(runId, RUN_OUTCOME.COMPLETED)),
              { parentRunId: PARENT_RUN_ID },
            ),
          );
          // The run reached its own terminal and parked before its persist,
          // which is the window the stop below has to land in.
          yield* Deferred.await(parked.started);

          const stop = testDefaultSession().runs.stop(runId, {
            reason: 'user',
          });

          expect(stop.accepted()).toBe(false);

          yield* stop.settlement;

          yield* Deferred.succeed(parked.release, undefined);
          const result = yield* Fiber.join(running);
          expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
          expect(yield* runEnds(ctx.session, runId)).toMatchObject([
            { outcome: RUN_OUTCOME.COMPLETED },
          ]);
          expect(testDefaultSession().runs.get(runId)?.handle).toBeUndefined();
        } finally {
          untrackRun(testDefaultSession().runs, runId);
        }
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

        const result = yield* runLifecycle(ctx, () =>
          Effect.fail(new DOMException('Request aborted', 'AbortError')),
        );

        expect(result.outcome).toBe(RUN_OUTCOME.CANCELLED);
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
            error: {
              kind: 'abort',
              message: 'Request aborted',
              userRetryable: false,
            },
            output: EMPTY_TOOL_USE_OUTPUT,
          },
        ]);
      }),
  );
});
