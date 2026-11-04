// E2E fixtures for the promoted "one loop, N strategies" child-run driver.
// These exercise the loop's own mechanics (queue acquire/drain, one
// run-handle interrupt target for the child's whole lifetime, per-turn delivery, terminal
// finalize) against a minimal fake strategy — the same contract every real
// strategy (codex, claude, native subagent) implements.
// Identical assertions apply regardless of which strategy is plugged in,
// since delivery/interrupt/terminal choreography all live in the loop.

import { layer } from '@effect/vitest';
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  SubscriptionRef,
  Context,
} from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  wakeRun: vi.fn(),
}));

// A delivery commits with its settlement; the parent's wake after it is
// what a fixture holds open or observes.
vi.mock('@agent/followUp/ToolUseFollowUp', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@agent/followUp/ToolUseFollowUp')>();
  return {
    ...original,
    wakeRun: mocks.wakeRun,
    // The parent's wake reaches `wakeRun` inside its module, which the mock
    // above cannot replace: the owed check is the original's, its wake the
    // mock's.
    wakeIfOwed: (runId: RunId) =>
      Effect.gen(function* () {
        const owed = yield* (yield* original.Inbox).owesResume(runId);
        if (owed === undefined) return false;
        return owed ? yield* mocks.wakeRun(runId) : Effect.void;
      }),
  };
});

import {
  generateRunId,
  qualifyAggregateId,
  type RunId,
} from '@texra-ai/harness/schemas';
import { Runs } from '@agent/runtime/runRegistry';
import {
  startChildRunLoop,
  type ChildRunLoopParams,
  type NativeChildStrategy,
} from '@agent/runtime/childRunLoop';
import { createChildRun } from '@agent/runtime/delegation/childRun';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Inbox } from '@agent/followUp/ToolUseFollowUp';
import { SessionRoots } from '@platform/rootedFs';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
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
import { shouldSkipWait } from '@tools/executions/waitCoordination';
import type { ProcessChildStrategy } from '@texra-ai/harness/plugins';

// A persistent store under a temp root, so a case can fail its writes
// (`sessionStoreFaults`); its run ends are the real `finalizeRun`'s.
const tempDirs = useTempDirs();

let session: Context.Context<SessionServices>;

const PARENT_RUN_ID = 'ffff01' as RunId;

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
  const started: Deferred.Deferred<void>[] = [];

  /** The start gate for the Nth call, created before that call exists. */
  const startedAt = (callIndex: number) =>
    Effect.gen(function* () {
      while (started.length < callIndex) {
        started.push(yield* Deferred.make<void>());
      }
      return started[callIndex - 1]!;
    });

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
        yield* Deferred.succeed(pendings[callIndex - 1]!, turn);
      }),
    rejectTurn: (callIndex, err) =>
      Effect.gen(function* () {
        yield* turnStarted(callIndex);
        yield* Deferred.fail(pendings[callIndex - 1]!, err);
      }),
  };
}

/** A process child's port for `runId`. */
const childRunPort = (runId: RunId) =>
  Effect.sync(() => createChildRun(Context.get(session, SessionLog), runId));

/**
 * Start a process child's loop with the fixture defaults (a port of its own
 * unless `extras` brings one); extras override any param. Setup is
 * synchronous through the queue claim, so the loop owns the run's queue by
 * the time the returned fiber is in hand; the fiber itself is detached, so
 * every test joins it before its body ends.
 */
const startLoop = (
  runId: RunId,
  strategy: ProcessChildStrategy<FakeTurn>,
  extras: Partial<Omit<ChildRunLoopParams<FakeTurn>, 'strategy'>> = {},
) =>
  Effect.gen(function* () {
    const childRun = extras.childRun ?? (yield* childRunPort(runId));
    const started = yield* startChildRunLoop({
      runId,
      parentRunId: PARENT_RUN_ID,
      agentName: 'fake',
      ...extras,
      childRun,
      strategy,
    }).pipe(Effect.provide(session));
    return started.fiber;
  });

/** Start a native child's loop: no port, its launch its whole run. Unless
 *  `budgeted`, it is awaited, which takes no budget slot. */
const startNativeLoop = (
  runId: RunId,
  strategy: NativeChildStrategy<FakeTurn>,
  budgeted = false,
) =>
  startChildRunLoop({
    runId,
    parentRunId: PARENT_RUN_ID,
    agentName: 'fake',
    ...(!budgeted && { awaited: true as const }),
    strategy,
  }).pipe(
    Effect.map((started) => started.fiber),
    Effect.provide(session),
  );

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wakeRun.mockReturnValue(Effect.succeed(Effect.void));
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
            // settlement, so a refused batch consumes nothing: the relaunched
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

            // The last (failed) turn's settlement rides the child's `run.end`,
            // which the store refuses: the end that commits instead records the
            // lost result, and the prompt it would have consumed stays queued.
            yield* refuseNextRunEnd;
            yield* resolveTurn(2, { kind: 'error-turn', value: 'final' });

            // The lost result is the end's, not the loop's: the loop ends cleanly.
            expect(Exit.isSuccess(yield* Fiber.await(loop))).toBe(true);
            expect(yield* queuedTexts(runId)).toEqual(['keep going']);
            expect(yield* runEnds(runId)).toMatchObject([
              {
                error: {
                  kind: 'result-lost',
                  message: expect.stringContaining('injected appendAll fault'),
                },
              },
            ]);
          }),
      );

      it.effect(
        '#8093 regression: a terminal turn finalizes this child before its wake step is even reached, so a resumed parent never self-stalls waiting on it',
        () =>
          Effect.gen(function* () {
            yield* setUp;
            // Regression: parent continuation submission can await the ENTIRE resumed
            // turn (`wakeRun` → … → `executeAgent`).
            // Before #8093, the loop awaited split enqueue/wake work inline in the
            // turn loop, and only finalized this child afterward in the outer
            // `finally` — so a resumed parent that
            // immediately calls `executions` with action=wait on this same run
            // could find it still RUNNING and block on itself for the whole wait
            // budget. Prove the fixed ordering: by the moment the wake step is even
            // reached, this run is already terminal — a resumed parent's wait
            // would resolve immediately instead of racing its own wake.
            const runId = loopRunId();

            const wakeReached = yield* Deferred.make<void>();
            const releaseWake = yield* Deferred.make<void>();
            let skippedAtWakeTime = false;
            mocks.wakeRun.mockImplementation(() =>
              Effect.gen(function* () {
                // Snapshot registry state the instant the wake step is reached. The
                // same moment a resumed parent's own turn would begin running.
                skippedAtWakeTime = shouldSkipWait(
                  Context.get(session, Runs),
                  SubscriptionRef.getUnsafe(
                    Context.get(session, SessionViewAccess).ref,
                  ),
                  runId,
                );
                yield* Deferred.succeed(wakeReached, undefined);
                yield* Deferred.await(releaseWake);
                return Effect.void;
              }),
            );

            const loop = yield* startLoop(runId, {
              stageLabel: 'Finalize-before-wake test',
              launch: () => Effect.succeed({ kind: 'terminal', value: 'done' }),
              interruptedTurn: () => ({ kind: 'terminal', value: 'cut' }),
              formatDelivery: (turn) =>
                Effect.succeed(`delivered:${turn.value}`),
              formatError: () => 'error',
            });

            yield* Deferred.await(wakeReached);
            expect(skippedAtWakeTime).toBe(true);

            yield* Deferred.succeed(releaseWake, undefined);
            yield* Fiber.join(loop);
            expect(Context.get(session, Runs).get(runId)).toBeUndefined();
          }),
      );

      it.effect(
        'lets a stopped parent go after each turn a native child delivers',
        () =>
          Effect.gen(function* () {
            yield* setUp;
            const log = Context.get(session, SessionLog);
            // The parent stops: its driver's hold ends, releasing its claim.
            yield* Effect.scoped(log.hold(PARENT_RUN_ID, { ends: true }));
            expect(yield* log.owns(PARENT_RUN_ID)).toBe(false);
            const runId = loopRunId();
            yield* log.settled;
            const owned: boolean[] = [];
            const strategy: NativeChildStrategy<FakeTurn> = {
              stageLabel: 'Delivers two turns',
              isTurnInterrupted: () => false,
              launch: (_notify, turns) =>
                Effect.gen(function* () {
                  for (const value of ['one', 'two']) {
                    yield* turns.turnPermit(Effect.void);
                    const { rows, alongside } = yield* turns.finishTurn({
                      kind: 'interim',
                      value,
                    });
                    // As the run loop commits a turn boundary: the child's
                    // rows and the parent's delivery in one transaction,
                    // whose scope is the delivery's hold on the parent.
                    yield* log.transact((tx) =>
                      Effect.gen(function* () {
                        const beside =
                          alongside === undefined ? [] : yield* alongside;
                        yield* tx.append([...rows, ...beside]);
                      }).pipe(Effect.scoped),
                    );
                    owned.push(yield* log.owns(PARENT_RUN_ID));
                  }
                  return { kind: 'terminal', value: 'done' } as const;
                }).pipe(Effect.provide(session)),
              formatDelivery: (turn) =>
                Effect.succeed(`delivered:${turn.value}`),
              formatError: () => 'error',
            };
            yield* Fiber.join(yield* startNativeLoop(runId, strategy));
            expect(owned).toStrictEqual([false, false]);
          }),
      );

      it.effect(
        'preserves #7491: a failed runTurn (thrown, not a value) delivers formatError to the parent',
        () =>
          Effect.gen(function* () {
            yield* setUp;
            const runId = loopRunId();
            const { strategy, resolveTurn, rejectTurn } = createFakeStrategy();
            const firstDelivered = yield* Deferred.make<void>();
            mocks.wakeRun.mockImplementation(() =>
              Effect.as(
                Deferred.succeed(firstDelivered, undefined),
                Effect.void,
              ),
            );

            const loop = yield* startLoop(runId, strategy);

            yield* resolveTurn(1, { kind: 'interim', value: 'first' });
            yield* Deferred.await(firstDelivered);
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
