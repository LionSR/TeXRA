import { layer } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Context, Layer } from 'effect';

import { afterEach, expect, vi } from 'vitest';

import {
  qualifyAggregateId,
  RUN_OUTCOME,
  type RunId,
} from '@texra-ai/harness/schemas';
import { setLogSink } from '@texra-ai/harness/node';
import { endRun } from '@agent/runtime/AgentRunLifecycle';
import { type RunReport } from '@agent/runtime/runReport';
import type { RunLaunch } from '@agent/runtime/run/AgentRun';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';
import { SessionLog } from '@shared/session/runHistory';
import { startAwaited } from '@test/support/runHandleFixtures';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

import { eventsOfType, recordSessionEvents } from '../progressTestUtils';
import { createTestLaunchContext } from './launchContextTestUtils';

/** The run's committed `run.end` rows, once the session's writes settled:
 *  what the run's one terminal writer (`finalizeRun`) said. */
const runEnds = (session: Context.Context<SessionServices>, runId: RunId) =>
  Effect.andThen(
    Context.get(session, SessionLog).settled,
    Effect.map(
      Context.get(session, SessionLog).runRows(
        qualifyAggregateId('run', runId),
        'lifecycle',
      ),
      (rows) => rows.lifecycles.filter((row) => row.type === 'run.end'),
    ),
  );

afterEach(() => {
  setLogSink(null);
  vi.restoreAllMocks();
});

let lifecycleFixtureCounter = 0;

/** A run of the file's session, with its launch context. */
const lifecycleFixture = (agent = 'test-agent') =>
  Effect.map(Effect.flatMap(TestSession, sessionHandleOf), (session) => {
    const runId =
      `e${(lifecycleFixtureCounter++).toString(16).padStart(5, '0')}` as RunId;
    const ctx = createTestLaunchContext({ runId, agent });
    // A run is registered before its lifecycle runs: an activation commits
    // onto the run's rows.
    publishTestRunStart(session, runId);
    return { runId, ctx, session };
  });

/** The launching run a subagent fixture names as its parent edge. */
const PARENT_RUN_ID = 'aa0001' as RunId;

/**
 * Park the run's terminal before its `run.end` write: its stage end, the
 * terminal's first step, enqueues a job that holds the session's publisher
 * until `release`, so the end's transaction queues behind it. `started`
 * resolves once that job holds the publisher.
 */
const parkTerminal = (
  ctx: RunLaunch,
  session: Context.Context<SessionServices>,
) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const endStage = ctx.parentStage.end.bind(ctx.parentStage);
    vi.spyOn(ctx.parentStage, 'end').mockImplementationOnce((outcome) => {
      Effect.runFork(
        Context.get(session, SessionLog).transact(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        ),
      );
      endStage(outcome);
    });
    return { started, release };
  });

// The file's session, as the process default session a host opens.
layer(Layer.provideMerge(TestSession.layer(), SessionGraph.layer), {
  excludeTestServices: true,
})('endRun', (it) => {
  it.effect(
    'does not let a stop abandon a run that completes without suspending',
    () =>
      Effect.gen(function* () {
        // The window a stop could once fall into: the run has returned, its live
        // interrupt context is detached, and its own finalize is parked at the
        // persist await. The terminal is uninterruptible, so the stop its
        // launch takes lands after the end the run reported.
        const { runId, ctx, session } = yield* lifecycleFixture();
        const parked = yield* parkTerminal(ctx, session);

        const running = yield* Effect.forkChild(
          startAwaited(
            Context.get(session, Runs),
            runId,
            endRun(
              { ...ctx, entry: { ...ctx.entry, parent: PARENT_RUN_ID } },
              Exit.succeed({
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

        const stop = Context.get(session, Runs).stop(runId, {
          reason: 'user',
          detachActiveChildren: false,
        });
        expect(stop.accepted()).toBe(true);
        yield* stop.settlement.pipe(Effect.provide(session));

        yield* Deferred.succeed(parked.release, undefined);
        yield* Fiber.await(running);
        expect(yield* runEnds(session, runId)).toMatchObject([
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
        const { runId, ctx, session } = yield* lifecycleFixture();
        const recorded = recordSessionEvents(session, {
          aggregateId: qualifyAggregateId('run', runId),
        });

        yield* endRun(
          ctx,
          Exit.fail(new DOMException('Request aborted', 'AbortError')),
        ).pipe(Effect.provide(session));
        yield* Context.get(session, SessionLog).settled;
        // A run that never ran a turn writes no step of its own: `run.end` is
        // the whole of what it says.
        expect(eventsOfType(yield* recorded.read, 'run.position')).toEqual([]);
        expect(yield* runEnds(session, runId)).toMatchObject([
          {
            outcome: RUN_OUTCOME.CANCELLED,
            error: { kind: 'abort', userRetryable: false },
            output: { response: '', files: [] },
          },
        ]);
      }),
  );
});
