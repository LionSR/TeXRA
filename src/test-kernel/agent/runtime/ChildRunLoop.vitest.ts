// Test composition imports
import '@test/support/sessionGraphTestSetup';

// E2E fixtures for the promoted "one loop, N strategies" child-run driver.
// These exercise the loop's own mechanics (queue acquire/drain, one
// run-handle interrupt target for the child's whole lifetime, per-turn delivery, terminal
// finalize) against a minimal fake strategy — the same contract every real
// strategy (codex, claude, native subagent) implements.
// Identical assertions apply regardless of which strategy is plugged in,
// since delivery/interrupt/terminal choreography all live in the loop.

import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { registryOf, Runs } from '@agent/runtime/runRegistry';

const mocks = vi.hoisted(() => ({
  startFollowUpWake: vi.fn(),
}));

// A delivery commits with its settlement; the parent's wake after it is
// what a fixture holds open or observes.
vi.mock('@agent/followUp/ToolUseFollowUp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/followUp/ToolUseFollowUp')>()),
  startFollowUpWake: mocks.startFollowUpWake,
}));

import { readChildTurnState } from '@agent/storage/runRecords';
import {
  startChildRunLoop,
  type ChildRunLoopParams,
  type NativeChildStrategy,
  type ProcessChildStrategy,
} from '@agent/runtime/childRunLoop';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { qualifyAggregateId, RUN_OUTCOME, type RunId } from '@shared/schemas';
import { closeTestDefaultSession, untrackRun } from '@test/support/sessionEnd';
import { setupPlatform } from '@test/support/setupPlatform';
import { sessionStoreFaults } from '@test/support/storeFaults';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  createProcessSession,
  publishTestRunStart,
  queuedFollowUps,
} from '@test/support/sessionTestUtils';
import { createChildRun } from '@tools/delegation/childRun';
import { generateRunId } from '@utils/core';

// A persistent store under a temp root, so a case can fail its writes
// (`sessionStoreFaults`); its run ends are the real `finalizeRun`'s.
const tempDirs = useTempDirs();
setupPlatform(() => createTempDirPlatform('texra-child-loop-', tempDirs));

let session: SessionHandle;
const trackedRunIds = new Set<RunId>();

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
  /** Number of launch/runTurn calls made so far. */
  callCount: () => number;
  /** Wait for the Nth (1-indexed) launch/runTurn call to have started. */
  turnStarted: (callIndex: number) => Effect.Effect<void>;
  /** Resolve the Nth (1-indexed) launch/runTurn call — waits for it to have started. */
  resolveTurn: (callIndex: number, turn: FakeTurn) => Effect.Effect<void>;
  /** Reject the Nth (1-indexed) launch/runTurn call — waits for it to have started. */
  rejectTurn: (callIndex: number, err: Error) => Effect.Effect<void>;
  readonly errors: unknown[];
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
  const errors: unknown[] = [];

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
    runTurn: () => runTurn,
    isTurnError: (turn) => turn.kind === 'error-turn',
    formatDelivery: (turn) => Effect.succeed(`delivered:${turn.value}`),
    formatError: (turn, err) => {
      errors.push(err);
      return `error:${turn?.value ?? 'thrown'}`;
    },
  };

  const turnStarted = (callIndex: number) =>
    Effect.flatMap(startedAt(callIndex), (gate) => Deferred.await(gate));

  return {
    strategy,
    callCount: () => pendings.length,
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
    errors,
  };
}

/** A strategy whose very first turn is already terminal. */
function createTerminalStrategy(
  stageLabel: string,
  launch: (signal: AbortSignal) => Effect.Effect<FakeTurn, Error> = () =>
    Effect.succeed({ kind: 'terminal', value: 'done' }),
  formatDelivery: ProcessChildStrategy<FakeTurn>['formatDelivery'] = (turn) =>
    Effect.succeed(`delivered:${turn.value}`),
): ProcessChildStrategy<FakeTurn> {
  return {
    stageLabel,
    launch,
    formatDelivery,
    formatError: () => 'error',
  };
}

/** A process child's port for `runId`, untracked after the test. */
const childRunPort = (runId: RunId) =>
  createChildRun(session, runId, PARENT_RUN_ID, {
    kind: 'agent',
    agent: 'fake-cli',
    tool: 'codex',
  }).pipe(
    Effect.provideService(Runs, session.runs),
    Effect.tap(() => Effect.sync(() => trackedRunIds.add(runId))),
  );

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
      session,
      runId,
      parentRunId: PARENT_RUN_ID,
      agentName: 'fake',
      ...extras,
      childRun,
      strategy,
    }).pipe(Effect.provideService(Runs, session.runs));
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
    session,
    runId,
    parentRunId: PARENT_RUN_ID,
    agentName: 'fake',
    ...(!budgeted && { awaited: true as const }),
    strategy,
  }).pipe(
    Effect.map((started) => started.fiber),
    Effect.provideService(Runs, session.runs),
  );

/** The run's `run.end` rows, in order. */
const runEnds = (runId: RunId) =>
  Effect.map(session.log.rows(qualifyAggregateId('run', runId)), (rows) =>
    rows.filter((row) => row.type === 'run.end'),
  );

/** The next `run.end` the store is asked to commit is refused, for the
 *  rest of the test's scope. */
const refuseNextRunEnd = Effect.gen(function* () {
  const faults = yield* sessionStoreFaults(session.roots.storage);
  yield* faults.failNext('appendAll', 'run.end');
});

beforeEach(async () => {
  session = await Effect.runPromise(createProcessSession({ persistent: true }));
  publishTestRunStart(session, PARENT_RUN_ID);
  await Effect.runPromise(session.log.settled);
  vi.clearAllMocks();
  mocks.startFollowUpWake.mockReturnValue(Effect.succeed(Effect.void));
});

afterEach(async () => {
  for (const runId of trackedRunIds) {
    untrackRun(session.runs, runId);
  }
  trackedRunIds.clear();
  await Effect.runPromise(closeTestDefaultSession);
});

describe('childRunLoop E2E fixtures', () => {
  it.effect.each([RUN_OUTCOME.CANCELLED, RUN_OUTCOME.FAILED])(
    'persists %s when the run ends before its engine handle exists',
    (outcome) =>
      Effect.gen(function* () {
        const runId = loopRunId();
        yield* session.log.settled;
        yield* session.log.hold(runId);
        const launch = vi.fn(() =>
          Effect.fail(new Error('Engine startup failed')),
        );
        let stop: ReturnType<typeof session.runs.stop> | undefined;
        // The stop lands inside loop setup, once its target is reserved and
        // before the launch.
        const reserve = registryOf(session.runs).reserveChildActivation.bind(
          session.runs,
        );
        const claim = vi
          .spyOn(registryOf(session.runs), 'reserveChildActivation')
          .mockImplementationOnce((activation) => {
            const release = reserve(activation);
            if (outcome === RUN_OUTCOME.CANCELLED)
              stop = session.runs.stop(runId, { reason: 'user' });
            return release;
          });
        const loop = yield* startNativeLoop(runId, {
          stageLabel: 'Engine startup',
          launch,
          formatDelivery: (turn) => Effect.succeed(`delivered:${turn.value}`),
          formatError: () => 'error',
        }).pipe(Effect.ensuring(Effect.sync(() => claim.mockRestore())));
        if (stop) {
          expect(stop.accepted()).toBe(true);
          yield* stop.settlement;
        }
        yield* Fiber.join(loop);

        if (outcome === RUN_OUTCOME.CANCELLED) {
          expect(launch).not.toHaveBeenCalled();
          expect(mocks.startFollowUpWake).not.toHaveBeenCalled();
          expect(yield* readChildTurnState(session, runId)).toEqual({
            active: null,
            lastCompleted: null,
          });
        }
        const rows = yield* session.log.rows(qualifyAggregateId('run', runId));
        expect(rows.filter((row) => row.type === 'run.end')).toMatchObject([
          { outcome },
        ]);
      }),
  );

  it.effect(
    'keeps a consumed prompt queued when the turn result fails to persist',
    () =>
      Effect.gen(function* () {
        // The prompt's `followup.consumed` rows commit with the turn's
        // settlement, so a refused batch consumes nothing: the relaunched
        // loop seeds the prompt and runs it again.
        const runId = loopRunId();
        const { strategy, resolveTurn, turnStarted } = createFakeStrategy();
        const loop = yield* startLoop(runId, strategy);

        yield* resolveTurn(1, { kind: 'interim', value: 'first' });
        yield* session.followUps.send(runId, {
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
        expect(session.runs.get(runId)?.live === true).toBe(false);
      }),
  );

  it.effect(
    '#8093 regression: a terminal turn finalizes this child before its wake step is even reached, so a resumed parent never self-stalls waiting on it',
    () =>
      Effect.gen(function* () {
        // Regression: parent continuation submission can await the ENTIRE resumed
        // turn (`resumeOnSession` → … → `resumeToolUseFromResumeData`).
        // Before #8093, the loop awaited split enqueue/wake work inline in the
        // turn loop, and only finalized this child (untracking its run
        // handle) afterward in the outer `finally` — so a resumed parent that
        // immediately calls `executions` with action=wait on this same run
        // could find it still RUNNING and block on itself for the whole wait
        // budget. Prove the fixed ordering: by the moment the wake step is even
        // reached, this run is already untracked (terminal in the registry)
        // — a resumed parent's wait would resolve immediately instead of racing
        // its own wake.
        const runId = loopRunId();

        const wakeReached = yield* Deferred.make<void>();
        const releaseWake = yield* Deferred.make<void>();
        let handleAtWakeTime: unknown;
        mocks.startFollowUpWake.mockImplementation(() =>
          Effect.gen(function* () {
            // Snapshot registry state the instant the wake step is reached. The
            // same moment a resumed parent's own turn would begin running.
            handleAtWakeTime = session.runs.get(runId)?.handle;
            yield* Deferred.succeed(wakeReached, undefined);
            yield* Deferred.await(releaseWake);
            return Effect.void;
          }),
        );

        const strategy = createTerminalStrategy('Finalize-before-wake test');

        const loop = yield* startLoop(runId, strategy);

        yield* Deferred.await(wakeReached);
        expect(handleAtWakeTime).toBeUndefined();
        expect(session.runs.get(runId)?.handle).toBeUndefined();

        yield* Deferred.succeed(releaseWake, undefined);
        yield* Fiber.join(loop);
        expect(session.runs.get(runId)?.live === true).toBe(false);
      }),
  );

  it.effect(
    'preserves #7491: a failed runTurn (thrown, not a value) delivers formatError to the parent',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, resolveTurn, rejectTurn, errors } =
          createFakeStrategy();
        const firstDelivered = yield* Deferred.make<void>();
        mocks.startFollowUpWake.mockImplementation(() =>
          Effect.as(Deferred.succeed(firstDelivered, undefined), Effect.void),
        );

        const loop = yield* startLoop(runId, strategy);

        yield* resolveTurn(1, { kind: 'interim', value: 'first' });
        yield* Deferred.await(firstDelivered);
        expect(mocks.startFollowUpWake).toHaveBeenCalledTimes(1);

        expect(
          yield* session.followUps.send(runId, {
            text: 'resume please',
            from: { kind: 'user' as const },
          }),
        ).toMatchObject({ kind: 'queued' });

        const resumeFailure = new Error('resume storage unreadable');
        yield* rejectTurn(2, resumeFailure);

        yield* Fiber.join(loop);
        expect(yield* queuedTexts(PARENT_RUN_ID)).toEqual([
          'delivered:first',
          'error:thrown',
        ]);
        expect(errors).toContain(resumeFailure);
        expect(session.runs.get(runId)?.live === true).toBe(false);
      }),
  );
});
