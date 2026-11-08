import { layer } from '@effect/vitest';
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Schema,
} from 'effect';

import { afterEach, expect, vi } from 'vitest';

import {
  generateRunId,
  RunIdSchema,
  qualifyAggregateId,
  RUN_OUTCOME,
  AgentConfigSchema,
  type RunId,
} from '@texra-ai/harness/schemas';
import { setLogSink } from '@texra-ai/harness/node';
import { endRun } from '@agent/runtime/AgentRunLifecycle';
import { type RunReport } from '@agent/runtime/runReport';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { registryOf, Runs } from '@agent/runtime/runRegistry';
import { SessionLog } from '@shared/session/runHistory';
import { startAwaited } from '@test/support/runHandleFixtures';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

import { testLaunch } from '@test/support/scriptedRunLayers';

/** The run's committed `run.end` rows, once the session's writes settled:
 *  what the run's one terminal writer (`endRun`) said. */
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

/** A run of the file's session, with its launch context. */
const lifecycleFixture = (agent = 'test-agent') =>
  Effect.flatMap(Effect.flatMap(TestSession, sessionHandleOf), (session) => {
    const runId = generateRunId();
    const ctx = testLaunch(runId, {
      config: Schema.decodeUnknownSync(AgentConfigSchema)({
        agent,
        model: 'test-model',
      }),
    });
    // A run is registered before its lifecycle runs: an activation commits
    // onto the run's rows.
    return Effect.as(publishTestRunStart(session, runId), {
      runId,
      ctx,
      session,
    });
  });

/** The launching run a subagent fixture names as its parent edge. */
const PARENT_RUN_ID = Schema.decodeUnknownSync(RunIdSchema)('aa0001');

/**
 * Park the run's terminal before its `run.end` write: its first read of the
 * session log (`lost`) enqueues a job that holds the session's publisher
 * until `release`, so the end's transaction queues behind it. `started`
 * resolves once that job holds the publisher. The job runs in the case's
 * scope, so a failure or a hold the case forgot ends with it.
 */
const parkTerminal = (session: Context.Context<SessionServices>) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const log = Context.get(session, SessionLog);
    const lost = log.lost.bind(log);
    const runFork = yield* FiberSet.makeRuntime();
    vi.spyOn(log, 'lost').mockImplementationOnce((runId) => {
      runFork(
        log.transact(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        ),
      );
      return lost(runId);
    });
    return { started, release };
  });

// The file's session, as the process default session a host opens.
layer(Layer.provideMerge(TestSession.layer(), SessionGraph.hosted), {
  excludeTestServices: true,
})('endRun', (it) => {
  it.effect(
    'does not let a stop abandon a run that completes without suspending',
    () =>
      Effect.gen(function* () {
        // The window a stop could once fall into: the run has returned and
        // its own end is parked at the persist await. The terminal is
        // uninterruptible, so the stop its launch takes lands after the end
        // the run reported.
        const { runId, ctx, session } = yield* lifecycleFixture();
        const parked = yield* parkTerminal(session);

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

        // The stop a launch takes when its caller lets go: the fiber's
        // interruption, writing nothing (a `stop` would queue its row behind
        // the parked persist and land after it).
        expect(registryOf(Context.get(session, Runs)).interrupt(runId)).toBe(
          true,
        );

        yield* Deferred.succeed(parked.release, undefined);
        yield* Fiber.await(running);
        expect(yield* runEnds(session, runId)).toMatchObject([
          { outcome: RUN_OUTCOME.COMPLETED },
        ]);
      }),
  );
});
