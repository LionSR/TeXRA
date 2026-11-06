// E2E fixtures for the "one loop, N strategies" child-run driver. These
// exercise the loop's own mechanics (queue acquire/drain, one run fiber as
// the child's interrupt target for its whole lifetime, per-turn delivery,
// the terminal end) against a minimal fake process strategy — the same
// contract every real process strategy (codex, claude) implements.
// Identical assertions apply regardless of which strategy is plugged in,
// since delivery/interrupt/terminal choreography all live in the loop.

import { layer } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Context, Schema } from 'effect';
import { assert, describe, expect } from 'vitest';

import {
  RunIdSchema,
  generateRunId,
  qualifyAggregateId,
  type RunId,
} from '@texra-ai/harness/schemas';
import {
  startProcessChildRunLoop,
  type ProcessChildRunLoopParams,
} from '@agent/runtime/childRunLoop';
import { createChildRun } from '@agent/runtime/delegation/childRun';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Inbox } from '@agent/followUp/Inbox';
import { SessionRoots } from '@platform/rootedFs';
import { SessionLog } from '@shared/session/runHistory';
import {
  persistentTestSession,
  sessionStoreFaults,
} from '@test/support/storeFaults';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  publishTestRunStart,
  queuedFollowUps,
} from '@test/support/sessionTestUtils';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import type { ProcessChildStrategy } from '@texra-ai/harness/plugins';

// A persistent store under a temp root, so a case can fail its writes
// (`sessionStoreFaults`); its run ends are the real `endRunRows`'s.
const tempDirs = useTempDirs();

let session: Context.Context<SessionServices>;

// The parent has its `run.start` and nothing else: a delivery queues for
// it, and the wake it gets (no records to resume) is a logged warning.
const PARENT_RUN_ID = Schema.decodeUnknownSync(RunIdSchema)('ffff01');

/** The run id a fixture drives, with its `run.start` (a child of
 *  {@link PARENT_RUN_ID}, as a launch names it) already committed. */
function loopRunId(): RunId {
  const runId = generateRunId();
  publishTestRunStart(session, runId, { parent: PARENT_RUN_ID });
  return runId;
}

/** The text of each follow-up a run's rows still queue. */
const queuedTexts = (runId: RunId) =>
  Effect.map(queuedFollowUps(session, runId), (followUps) =>
    followUps.map((followUp) => followUp.text),
  );

/** A turn the fake strategy can produce: interim (loop continues) or terminal. */
interface FakeTurn {
  readonly kind: 'interim' | 'terminal' | 'error-turn';
  readonly value: string;
}

interface FakeStrategyHandle {
  readonly strategy: ProcessChildStrategy<FakeTurn>;
  /** Wait for the Nth (1-indexed) launch/runTurn call to have started. */
  turnStarted: (callIndex: number) => Effect.Effect<void>;
  /** Resolve the Nth (1-indexed) launch/runTurn call — waits for it to have started. */
  resolveTurn: (callIndex: number, turn: FakeTurn) => Effect.Effect<void>;
  /** Reject the Nth (1-indexed) launch/runTurn call — waits for it to have started. */
  rejectTurn: (callIndex: number, err: Error) => Effect.Effect<void>;
}

/**
 * A minimal strategy whose `launch`/`runTurn` are both driven by externally-
 * completed Deferreds, one per call, indexed 1-based by call order — lets a
 * test control exactly when a specific turn "completes" (not just
 * "whichever turn is currently pending", which races against the loop
 * re-invoking runTurn) and observe every delivery. A second Deferred per call
 * is the loop's own "this turn has started" signal, so a test waits on the
 * turn instead of polling the call count.
 */
function createFakeStrategy(): FakeStrategyHandle {
  const pendings: Deferred.Deferred<FakeTurn, Error>[] = [];
  const started = new Map<number, Deferred.Deferred<void>>();

  /** The start gate for the Nth call, created before that call exists. */
  const startedAt = (callIndex: number) =>
    Effect.sync(() => {
      const existing = started.get(callIndex);
      if (existing !== undefined) return existing;
      const gate = Deferred.makeUnsafe<void>();
      started.set(callIndex, gate);
      return gate;
    });

  /** The Nth call's pending turn: it exists once that call has started. */
  const pendingAt = (callIndex: number) => {
    const pending = pendings[callIndex - 1];
    assert(pending !== undefined, `call ${callIndex} has not started`);
    return pending;
  };

  const runTurn = Effect.gen(function* () {
    const deferred = yield* Deferred.make<FakeTurn, Error>();
    pendings.push(deferred);
    yield* Deferred.succeed(yield* startedAt(pendings.length), undefined);
    return yield* Deferred.await(deferred);
  });

  const strategy: ProcessChildStrategy<FakeTurn> = {
    stageLabel: 'Fake child run',
    launch: () => runTurn,
    cli: {
      runTurn: () => runTurn,
      pauseNotice: () => undefined,
      onTurnSuccess: () => {},
      releaseSessionOwnership: () => {},
    },
    isTurnError: (turn) => turn.kind === 'error-turn',
    formatDelivery: (turn) => Effect.succeed(`delivered:${turn.value}`),
    formatError: (turn) => `error:${turn?.value ?? 'thrown'}`,
  };

  const turnStarted = (callIndex: number) =>
    Effect.flatMap(startedAt(callIndex), (gate) => Deferred.await(gate));

  return {
    strategy,
    turnStarted,
    resolveTurn: (callIndex, turn) =>
      Effect.gen(function* () {
        yield* turnStarted(callIndex);
        yield* Deferred.succeed(pendingAt(callIndex), turn);
      }),
    rejectTurn: (callIndex, err) =>
      Effect.gen(function* () {
        yield* turnStarted(callIndex);
        yield* Deferred.fail(pendingAt(callIndex), err);
      }),
  };
}

/** A process child's port for `runId`. */
const childRunPort = (runId: RunId) =>
  Effect.sync(() => createChildRun(Context.get(session, SessionLog), runId));

/**
 * Start a process child's loop with the fixture defaults (a port of its own
 * unless `extras` brings one); extras override any param. The loop owns the
 * run's queue by the time the returned fiber is in hand; the fiber itself
 * is the run's, so every test joins it before its body ends.
 */
const startLoop = (
  runId: RunId,
  strategy: ProcessChildStrategy<FakeTurn>,
  extras: Partial<Omit<ProcessChildRunLoopParams<FakeTurn>, 'strategy'>> = {},
) =>
  Effect.gen(function* () {
    const childRun = extras.childRun ?? (yield* childRunPort(runId));
    const started = yield* startProcessChildRunLoop({
      runId,
      parentRunId: PARENT_RUN_ID,
      agentName: 'fake',
      ...extras,
      childRun,
      strategy,
    }).pipe(Effect.provide(session));
    return started.fiber;
  });

/** The run's `run.end` rows, in order. */
const runEnds = (runId: RunId) =>
  Effect.map(
    Context.get(session, SessionLog).runRows(
      qualifyAggregateId('run', runId),
      'lifecycle',
    ),
    (rows) => rows.lifecycles.filter((row) => row.type === 'run.end'),
  );

/** The next `run.end` the store is asked to commit is refused, for the
 *  rest of the test's scope. */
const refuseNextRunEnd = Effect.gen(function* () {
  const faults = yield* sessionStoreFaults(
    Context.get(session, SessionRoots).storage,
  );
  yield* faults.failNext('appendAll', 'run.end');
});

/** Each case's start: the session over the test's store, with the parent's
 *  `run.start` committed. The session closes with the test's scope. */
const setUp = Effect.gen(function* () {
  session = yield* persistentTestSession();
  publishTestRunStart(session, PARENT_RUN_ID);
  yield* Context.get(session, SessionLog).settled;
});

describe('childRunLoop E2E fixtures', () => {
  layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
    it.layer(
      FakeHost.layer(() =>
        createTempDirPlatform('texra-child-loop-', tempDirs),
      ),
      { buildPerTest: true },
    )((it) => {
      it.effect(
        'keeps a consumed prompt queued when the turn result fails to persist',
        () =>
          Effect.gen(function* () {
            yield* setUp;
            // The prompt's `followup.consumed` rows commit with the turn's
            // result, so a refused batch consumes nothing: the relaunched
            // loop seeds the prompt and runs it again.
            const runId = loopRunId();
            const { strategy, resolveTurn, turnStarted } = createFakeStrategy();
            const loop = yield* startLoop(runId, strategy);

            yield* resolveTurn(1, { kind: 'interim', value: 'first' });
            yield* Context.get(session, Inbox).send(runId, {
              text: 'keep going',
              from: { kind: 'user' as const },
            });
            yield* turnStarted(2);

            // The last (failed) turn's result rides the child's `run.end`,
            // which the store refuses: the run's terminal fact is gone, so
            // the loop fails, and the prompt it would have consumed stays
            // queued for the run's next activation.
            yield* refuseNextRunEnd;
            yield* resolveTurn(2, { kind: 'error-turn', value: 'final' });

            const exit = yield* Fiber.await(loop);
            assert(Exit.isFailure(exit));
            expect(Cause.squash(exit.cause)).toMatchObject({
              message: expect.stringContaining(
                'terminal state was not persisted',
              ),
            });
            expect(yield* queuedTexts(runId)).toEqual(['keep going']);
            expect(yield* runEnds(runId)).toEqual([]);
          }),
      );

      it.effect(
        'preserves #7491: a failed runTurn (thrown, not a value) delivers formatError to the parent',
        () =>
          Effect.gen(function* () {
            yield* setUp;
            const runId = loopRunId();
            const { strategy, resolveTurn, rejectTurn } = createFakeStrategy();

            const loop = yield* startLoop(runId, strategy);

            yield* resolveTurn(1, { kind: 'interim', value: 'first' });
            // Read by the loop's own reader once its interim turn commits
            // and it waits for the next batch.
            yield* Context.get(session, Inbox).send(runId, {
              text: 'resume please',
              from: { kind: 'user' as const },
            });

            yield* rejectTurn(2, new Error('resume storage unreadable'));

            yield* Fiber.join(loop);
            expect(yield* queuedTexts(PARENT_RUN_ID)).toEqual([
              'delivered:first',
              'error:thrown',
            ]);
          }),
      );
    });
  });
});
