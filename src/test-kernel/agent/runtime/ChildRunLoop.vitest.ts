// Test composition imports
import '@test/support/defaultSessionTestSetup';

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

import { getRunRecords } from '@agent/storage';
import { readChildTurnState } from '@agent/storage/runRecords';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import {
  startChildRunLoop,
  type ChildRunLoopParams,
  type ChildRunPorts,
  type NativeChildStrategy,
  type ProcessChildStrategy,
} from '@agent/runtime/childRunLoop';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  qualifyAggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
} from '@shared/schemas';
import { DatabaseNotOwner } from '@shared/session/database';
import { closeTestDefaultSession, untrackRun } from '@test/support/sessionEnd';
import { setupPlatform } from '@test/support/setupPlatform';
import { sessionStoreFaults } from '@test/support/storeFaults';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  createProcessSession,
  publishTestRunStart,
  queuedFollowUps,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { FakeConfigProvider } from '@test/support/FakePlatform';
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

/**
 * Move the parent run's folded phase, the way the runtime does: an
 * activation row makes it running, the terminal row ends it. The fold is
 * the one phase authority, so a follow-up test states its premise in rows.
 */
const foldParentPhase = (active: boolean) =>
  Effect.gen(function* () {
    const aggregateId = qualifyAggregateId('run', PARENT_RUN_ID);
    publishTestRows(session, [
      active
        ? {
            type: 'run.activate',
            aggregateId,
          }
        : {
            type: 'run.end',
            aggregateId,
            outcome: RUN_OUTCOME.COMPLETED,
            output: emptyRunEndOutput(),
          },
    ]);
    yield* session.log.settled;
  });

/** The text of each follow-up a run's rows still queue. */
const queuedTexts = (runId: RunId) =>
  Effect.map(queuedFollowUps(session, runId), (followUps) =>
    followUps.map((followUp) => followUp.text),
  );

/** Reads a run's queued follow-up texts on the process runtime, for the
 *  real-timer `vi.waitFor` poll the ownership test runs on. */
const readQueuedTexts = (runId: RunId) => Effect.runPromise(queuedTexts(runId));

/** Lets a forked loop reach its budget permit wait or its queue block. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
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
    isTerminal: (turn) => turn.kind === 'terminal',
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

/** The AbortError shape a real strategy's abortController rejection carries. */
function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** A strategy whose very first turn is already terminal. */
function createTerminalStrategy(
  stageLabel: string,
  launch: (
    ports: ChildRunPorts,
    signal: AbortSignal,
  ) => Effect.Effect<FakeTurn, Error> = () =>
    Effect.succeed({ kind: 'terminal', value: 'done' }),
  formatDelivery: ProcessChildStrategy<FakeTurn>['formatDelivery'] = (turn) =>
    Effect.succeed(`delivered:${turn.value}`),
): ProcessChildStrategy<FakeTurn> {
  return {
    stageLabel,
    launch,
    isTerminal: () => true,
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
    return yield* startChildRunLoop({
      session,
      runId,
      parentRunId: PARENT_RUN_ID,
      agentName: 'fake',
      ...extras,
      childRun,
      strategy,
    }).pipe(Effect.provideService(Runs, session.runs));
  });

/** Start a native child's loop: no port, its launch its whole run. */
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
    budgeted,
    strategy,
  }).pipe(Effect.provideService(Runs, session.runs));

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

/** The host's stop gesture on a child run: kill it, and settle the stop. */
const stopChildRun = (runId: RunId): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const stop = session.runs.stop(runId, { reason: 'user' });
    expect(stop.accepted()).toBe(true);
    yield* stop.settlement;
  });

beforeEach(async () => {
  session = await Effect.runPromise(createProcessSession({ persistent: true }));
  publishTestRunStart(session, PARENT_RUN_ID);
  await Effect.runPromise(session.log.settled);
  vi.clearAllMocks();
  mocks.startFollowUpWake.mockReturnValue(Effect.succeed(true));
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
    'a turn refused as DatabaseNotOwner stops the loop instead of taking another turn',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, callCount, rejectTurn, turnStarted } =
          createFakeStrategy();

        const loop = yield* startLoop(runId, strategy);
        yield* turnStarted(1);
        // The claim moved to another process mid-run: the append the turn
        // made is refused, and the loop stops rather than take another turn.
        yield* rejectTurn(
          1,
          new DatabaseNotOwner({
            aggregateId: qualifyAggregateId('run', runId),
            ownerId: null,
            closed: false,
          }),
        );

        yield* Fiber.join(loop);
        expect(callCount()).toBe(1);
      }),
  );

  it.effect(
    'unwinds provider ownership and loop resources when synchronous setup fails',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const releaseSessionOwnership = vi.fn();
        const childRun = yield* childRunPort(runId);
        // The setup's own step fails: the run refuses its tracking.
        vi.spyOn(childRun, 'track').mockImplementation(() => {
          throw new Error('loop registration failed');
        });
        const { strategy } = createFakeStrategy();
        const error = yield* Effect.flip(
          startLoop(
            runId,
            { ...strategy, releaseSessionOwnership },
            { agentName: 'fake-cli', childRun },
          ),
        );
        expect(error.message).toContain('loop registration failed');
        expect(releaseSessionOwnership).toHaveBeenCalledOnce();
        expect(session.runs.get(runId)?.live === true).toBe(false);
        // The failed setup left no generation fiber behind.
        expect(registryOf(session.runs).interrupt(runId)).toBe(false);
        expect(yield* queuedFollowUps(session, runId)).toEqual([]);
      }),
  );

  it.effect(
    'a shutdown stop interrupts a real agent-CLI initial-turn loop and releases ownership once',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const aborted = vi.fn();
        const releaseSessionOwnership = vi.fn();
        // An agent-CLI child is a process child, so the fixture is one: the
        // loop's own fiber survives the stop (the ruled permanent resident)
        // and the loop's abort signal is what reaches the strategy's
        // in-flight launch. A native-shaped fixture would take the stop as
        // the run fiber's interruption instead, which the launch's abort
        // listener is not guaranteed to observe.
        const launched = yield* Deferred.make<void>();

        const strategy: ProcessChildStrategy<FakeTurn> = {
          stageLabel: 'fake-cli session',
          launch: (_ports, signal) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(launched, undefined);
              return yield* Effect.callback<never, Error>((resume) => {
                const rejectAbort = () => {
                  aborted();
                  resume(Effect.fail(createAbortError()));
                };
                if (signal.aborted) rejectAbort();
                else {
                  signal.addEventListener('abort', rejectAbort, { once: true });
                }
              });
            }),
          isTerminal: () => false,
          formatDelivery: () => Effect.succeed('unexpected delivery'),
          formatError: () => 'unexpected error',
          releaseSessionOwnership,
        };

        const loop = yield* startLoop(runId, strategy, {
          agentName: 'fake-cli',
        });

        // The loop body is a generation on the run's lane: it starts once
        // the lane admits it, not inside `startChildRunLoop`.
        yield* Deferred.await(launched);
        yield* registryOf(session.runs).stopAll();

        // A process child's loop fiber survives the stop: the aborted turn
        // ends the loop as interrupted and it finalizes CANCELLED.
        yield* Fiber.join(loop);
        expect(aborted).toHaveBeenCalledOnce();
        expect(session.runs.get(runId)?.live === true).toBe(false);
        expect(releaseSessionOwnership).toHaveBeenCalledOnce();
        expect(session.runs.get(runId)?.handle).toBeUndefined();
      }),
  );

  it.effect(
    'commits accepted-turn attribution before releasing the run lease',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, rejectTurn, turnStarted } = createFakeStrategy();

        const loop = yield* startLoop(runId, strategy);
        yield* turnStarted(1);
        // Acceptance is committed before the turn is dispatched, so the run's
        // report/result slots are attributable while the turn is still running.
        expect(yield* readChildTurnState(session, runId)).toEqual({
          active: { key: expect.any(String), index: 1 },
          lastCompleted: null,
        });

        // Stop the loop through its parent lineage: the stop reaches it via
        // its child activation.
        const stopping = yield* Effect.forkChild(
          session.runs.stop(PARENT_RUN_ID, { reason: 'user' }).settlement,
          { startImmediately: true },
        );
        yield* rejectTurn(1, createAbortError());
        yield* Fiber.join(stopping);
        // A process child's loop fiber survives the stop and ends the run.
        yield* Fiber.join(loop);

        // An interrupted turn never settles, so the acceptance row stands and
        // the lease is released only once the loop is done with it.
        expect(yield* readChildTurnState(session, runId)).toEqual({
          active: { key: expect.any(String), index: 1 },
          lastCompleted: null,
        });
      }),
  );

  it.live(
    'keeps follow-up ownership distinct across child-stream and native child lifecycles',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId();
        const turn = yield* Deferred.make<FakeTurn, Error>();
        const launchStarted = yield* Deferred.make<void>();
        const formatStarted = yield* Deferred.make<void>();
        // `formatDelivery` is an Effect, so both gates are Deferreds: the
        // formatter signals that it started and then waits for the delivery
        // text this test releases.
        const formattedDelivery = yield* Deferred.make<string>();
        let notifyProgress: ChildRunPorts['notify'] = () => {};
        const strategy = createTerminalStrategy(
          'Follow-up ownership',
          (ports) =>
            Effect.gen(function* () {
              notifyProgress = ports.notify;
              yield* Deferred.succeed(launchStarted, undefined);
              return yield* Deferred.await(turn);
            }),
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(formatStarted, undefined);
              return yield* Deferred.await(formattedDelivery);
            }),
        );
        publishTestRunStart(session, runId, { parent: PARENT_RUN_ID });
        const loop = yield* startLoop(runId, strategy);
        yield* Deferred.await(launchStarted);

        try {
          yield* foldParentPhase(true);
          expect(
            yield* submitFollowUp(
              PARENT_RUN_ID,
              { text: 'active parent', from: { kind: 'user' as const } },
              {
                session,
              },
            ),
          ).toEqual({ status: 'queued', wake: 'failed' });

          yield* foldParentPhase(false);
          expect(
            yield* submitFollowUp(
              PARENT_RUN_ID,
              {
                text: 'late child result',
                from: { kind: 'run' as const, runId: 'c41dc41dc41d' as RunId },
              },
              { session },
            ),
          ).toMatchObject({ status: 'failed' });
          expect(yield* queuedTexts(PARENT_RUN_ID)).toEqual(['active parent']);

          const releaseNativeChild = registryOf(
            session.runs,
          ).reserveChildActivation({
            runId: 'da7a01' as RunId,
            launchParent: PARENT_RUN_ID,
            retainsTerminalParent: true,
            interrupt: vi.fn(),
          });
          try {
            expect(
              yield* submitFollowUp(
                PARENT_RUN_ID,
                {
                  text: 'native child result',
                  from: { kind: 'user' as const },
                },
                {
                  session,
                },
              ),
            ).toEqual({ status: 'queued', wake: 'failed' });
          } finally {
            releaseNativeChild();
          }

          const terminalQueue = yield* queuedTexts(PARENT_RUN_ID);
          notifyProgress({ kind: 'started' });
          expect(yield* queuedTexts(PARENT_RUN_ID)).toEqual(terminalQueue);

          yield* foldParentPhase(true);
          notifyProgress({ kind: 'started' });
          // The loop writes progress after the port returns.
          const progressQueue = yield* Effect.promise(() =>
            vi.waitFor(async () => {
              const queued = await readQueuedTexts(PARENT_RUN_ID);
              expect(queued).toHaveLength(terminalQueue.length + 1);
              return queued;
            }),
          );

          yield* Deferred.succeed<FakeTurn, Error>(turn, {
            kind: 'terminal',
            value: 'done',
          });
          yield* Deferred.await(formatStarted);
          yield* registryOf(session.runs)['detachActiveChildren'](
            PARENT_RUN_ID,
          );
          notifyProgress({ kind: 'started' });
          yield* Deferred.succeed(formattedDelivery, 'delivered:done');
          yield* Fiber.join(loop);

          expect(yield* queuedTexts(PARENT_RUN_ID)).toEqual(progressQueue);
          expect(mocks.startFollowUpWake).not.toHaveBeenCalled();
        } finally {
          yield* session.followUps.closeInput(PARENT_RUN_ID);
          yield* registryOf(session.runs)['detachActiveChildren'](
            PARENT_RUN_ID,
          );
          yield* Deferred.succeed<FakeTurn, Error>(turn, {
            kind: 'terminal',
            value: 'done',
          });
          yield* Deferred.succeed(formattedDelivery, 'delivered:done');
          yield* Fiber.join(loop);
        }
      }),
  );

  it.effect('persists without parent delivery in persist-only mode', () =>
    Effect.gen(function* () {
      const runId = loopRunId();
      const { strategy, resolveTurn } = createFakeStrategy();

      const loop = yield* startLoop(
        runId,
        { ...strategy, deliveryMode: 'persistOnly' },
        { parentRunId: 'headless-parent' as RunId },
      );
      yield* resolveTurn(1, { kind: 'terminal', value: 'saved' });
      yield* Fiber.join(loop);

      expect(yield* getRunRecords(session, runId).readReport()).toBe(
        'delivered:saved',
      );
      expect(mocks.startFollowUpWake).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'reuses a terminal child stream for a separately authorized retry',
    () =>
      Effect.gen(function* () {
        const retryRunId = loopRunId();
        yield* session.followUps.open(PARENT_RUN_ID);

        yield* Fiber.join(
          yield* startLoop(retryRunId, createTerminalStrategy('First attempt')),
        );
        expect(session.runs.get(retryRunId)?.live === true).toBe(false);

        expect(
          yield* Fiber.join(
            yield* startLoop(
              retryRunId,
              createTerminalStrategy('Retry attempt'),
            ),
          ),
        ).toEqual({ kind: 'terminal', value: 'done' });
        const delivered = yield* queuedFollowUps(session, PARENT_RUN_ID);
        expect(delivered.map((item) => item.text)).toEqual([
          'delivered:done',
          'delivered:done',
        ]);
        expect(delivered[1]?.followUpId).not.toBe(delivered[0]?.followUpId);
        expect(session.runs.get(retryRunId)?.live === true).toBe(false);
      }),
  );

  it.effect('releases session ownership before delivering a failed turn', () =>
    Effect.gen(function* () {
      const runId = loopRunId();
      const { strategy, rejectTurn } = createFakeStrategy();
      const releaseSessionOwnership = vi.fn();
      // The in-mock assertion now fails the delivery as a defect rather than
      // being swallowed by a rejected promise the loop logs.
      mocks.startFollowUpWake.mockImplementation(() =>
        Effect.sync(() => {
          expect(releaseSessionOwnership).toHaveBeenCalledOnce();
          return true;
        }),
      );

      const loop = yield* startLoop(
        runId,
        { ...strategy, releaseSessionOwnership },
        { agentName: 'fake-cli' },
      );

      yield* rejectTurn(1, new Error('initial turn failed'));
      yield* Fiber.join(loop);
      expect(session.runs.get(runId)?.live === true).toBe(false);
      expect(releaseSessionOwnership).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    'delegate → interrupt mid-run: an interrupt during the first turn ends the run without a terminal delivery for that turn',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, rejectTurn, turnStarted } = createFakeStrategy();

        const loop = yield* startLoop(runId, strategy);

        yield* turnStarted(1);

        yield* stopChildRun(runId);
        // The stop aborts the in-flight turn, as a real process's would.
        yield* rejectTurn(1, createAbortError());

        yield* Fiber.join(loop);
        expect(mocks.startFollowUpWake).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'delegate → complete → follow-up delivery: an interim turn delivers, then the loop picks up a queued follow-up for the next turn',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, callCount, resolveTurn, turnStarted } =
          createFakeStrategy();
        const onTurnSuccess = vi.fn();
        const parentWake = vi.fn();
        const deliveryStarted = yield* Deferred.make<void>();
        const deliveryCompleted = yield* Deferred.make<void>();
        mocks.startFollowUpWake.mockImplementation(() =>
          Effect.gen(function* () {
            parentWake();
            yield* Deferred.succeed(deliveryStarted, undefined);
            yield* Deferred.await(deliveryCompleted);
            return true;
          }),
        );

        const loop = yield* startLoop(runId, {
          ...strategy,
          onTurnSuccess,
        });

        yield* resolveTurn(1, { kind: 'interim', value: 'first' });

        yield* Deferred.await(deliveryStarted);
        // The result is queued by the time its parent is woken.
        expect(mocks.startFollowUpWake).toHaveBeenCalledWith(
          PARENT_RUN_ID,
          session,
        );
        expect(yield* queuedTexts(PARENT_RUN_ID)).toEqual(['delivered:first']);
        // The loop starts delivery for turn N before reading the queue for turn
        // N+1. Even input already queued during delivery must not begin another
        // model turn until the parent has received this result.
        expect(onTurnSuccess).toHaveBeenCalledOnce();
        expect(onTurnSuccess.mock.invocationCallOrder[0]).toBeLessThan(
          parentWake.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );

        // Enqueue a follow-up on the same queue the loop is now blocked on.
        expect(
          yield* session.followUps.send(runId, {
            text: 'keep going',
            from: { kind: 'user' as const },
          }),
        ).toMatchObject({ kind: 'queued' });
        expect(callCount()).toBe(1);

        yield* Deferred.succeed(deliveryCompleted, undefined);
        // Waits for the loop to have actually invoked runTurn a second time —
        // NOT for the queue to read empty, which can happen synchronously on
        // enqueue (the fast "someone is already waiting" path never pushes to
        // the backing array at all) well before the loop's own continuation runs.
        yield* turnStarted(2);
        yield* resolveTurn(2, { kind: 'terminal', value: 'final' });

        yield* Fiber.join(loop);
        expect(yield* queuedTexts(PARENT_RUN_ID)).toEqual([
          'delivered:first',
          'delivered:final',
        ]);
        expect(session.runs.get(runId)?.live === true).toBe(false);
      }),
  );

  // it.live: the WAITING status is the session fold projecting the park row
  // the interim turn's settlement commits, and the loop offers
  // no in-fiber hook between the two, so the one surviving poll observes a
  // process-runtime fact under the live clock.
  it.live(
    'parks a child-stream loop on its own park row, so the next turn is admitted onto its queue',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, resolveTurn, turnStarted } = createFakeStrategy();
        const loop = yield* startLoop(runId, strategy);

        yield* resolveTurn(1, { kind: 'interim', value: 'first' });

        // Blocked between turns the run is idle, and the phase row says so: a
        // run that only looked busy is refused as `no_session` and its session
        // can never take another turn.
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(session.view.run(runId)?.status).toBe(RUN_PHASE.WAITING),
          ),
        );
        expect(
          registryOf(session.runs).getToolUseFollowUpTarget(runId),
        ).toEqual({
          kind: 'queue',
        });

        yield* session.followUps.send(runId, {
          text: 'keep going',
          from: { kind: 'user' as const },
        });
        yield* turnStarted(2);
        yield* session.log.settled;
        expect(session.view.run(runId)?.status).toBe(RUN_PHASE.RUNNING);
        yield* resolveTurn(2, { kind: 'terminal', value: 'final' });
        yield* Fiber.join(loop);
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

        // The last turn's settlement rides the child's `run.end`, which
        // the store refuses: the end that commits instead records the lost
        // result, and the prompt it would have consumed stays queued.
        yield* refuseNextRunEnd;
        yield* resolveTurn(2, { kind: 'terminal', value: 'final' });

        yield* Fiber.await(loop);
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
    'late result after parent stop: a turn that resolves after interruption is persisted but not delivered',
    () =>
      Effect.gen(function* () {
        // A process child (agent-CLI): its loop's own fiber survives the
        // stop — the ruled permanent resident — so an in-flight turn that
        // was already past its own interruption checkpoints can resolve
        // normally after the stop landed.
        const runId = loopRunId();
        const { strategy, resolveTurn, turnStarted } = createFakeStrategy();
        const releaseSessionOwnership = vi.fn();
        const loop = yield* startLoop(runId, {
          ...strategy,
          releaseSessionOwnership,
        });

        yield* turnStarted(1);
        // Stop the loop, then let the in-flight turn resolve normally (not
        // aborted) — mirrors a turn that was already past its own
        // interruption checkpoints when the stop landed.
        yield* stopChildRun(runId);
        yield* resolveTurn(1, { kind: 'terminal', value: 'late' });

        yield* Fiber.join(loop);
        expect(session.runs.get(runId)?.live === true).toBe(false);
        expect(yield* getRunRecords(session, runId).readReport()).toBe(
          'delivered:late',
        );
        expect(releaseSessionOwnership).toHaveBeenCalledOnce();
        expect(mocks.startFollowUpWake).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'kill during WAITING: interrupting the loop while it is blocked between turns ends the run without a hang',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, resolveTurn } = createFakeStrategy();
        const delivered = yield* Deferred.make<void>();
        mocks.startFollowUpWake.mockImplementation(() =>
          Effect.as(Deferred.succeed(delivered, undefined), true),
        );

        const loop = yield* startLoop(runId, strategy);

        yield* resolveTurn(1, { kind: 'interim', value: 'first' });

        yield* Deferred.await(delivered);
        // One macrotask lets the loop enter its queue wait; either way
        // the loop ends with exactly one delivery.
        yield* settle;
        // The loop is now blocked in its queue wait; its stop target is the
        // activation its start reserved on the run's run registry entry.
        yield* stopChildRun(runId);

        yield* Fiber.join(loop);
        expect(session.runs.get(runId)?.live === true).toBe(false);
        // Only the one interim delivery — the kill did not spawn another turn.
        expect(mocks.startFollowUpWake).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'a stopped child whose end the store refuses lets its handle go and ends failed by its backstop',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, resolveTurn } = createFakeStrategy();
        const delivered = yield* Deferred.make<void>();
        mocks.startFollowUpWake.mockImplementation(() =>
          Effect.as(Deferred.succeed(delivered, undefined), true),
        );
        const loop = yield* startLoop(runId, strategy);

        yield* resolveTurn(1, { kind: 'interim', value: 'first' });
        yield* Deferred.await(delivered);
        expect(mocks.startFollowUpWake).toHaveBeenCalledTimes(1);
        // One macrotask lets the loop reach its queue wait before the stop lands.
        yield* settle;
        yield* refuseNextRunEnd;

        // Loop is now between turns; the stop reaches it through its run registry
        // activation and the run's fiber.
        yield* stopChildRun(runId);

        const exit = yield* Fiber.await(loop);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(session.runs.get(runId)?.live === true).toBe(false);

        // Metadata failure must not retain the child handle or queue ownership.
        expect(session.runs.get(runId)?.handle).toBeUndefined();
        // The cancellation's end was refused; the backstop's says so.
        expect(yield* runEnds(runId)).toMatchObject([
          {
            outcome: RUN_OUTCOME.FAILED,
            error: {
              message: expect.stringContaining("The run's end was not saved"),
            },
          },
        ]);
      }),
  );

  it.effect(
    'leaves no interruptible child continuation while terminal delivery is in flight',
    () =>
      Effect.gen(function* () {
        // Terminal delivery (persist report / persist manifest / deliver
        // follow-up) runs after child finalization and lease release, so a
        // stop/kill landing in that window finds nothing left to interrupt. The
        // test inspects the run handle while delivery is deliberately held open.
        const runId = loopRunId();
        const deliveryStarted = yield* Deferred.make<void>();
        const deliveryGate = yield* Deferred.make<void>();
        mocks.startFollowUpWake.mockImplementation(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(deliveryStarted, undefined);
            yield* Deferred.await(deliveryGate);
            return true;
          }),
        );

        const strategy = createTerminalStrategy('Reregister test');

        const loop = yield* startLoop(runId, strategy);

        // Wait until delivery is mid-flight (blocked on our gate).
        yield* Deferred.await(deliveryStarted);

        // A stop landing in that window reaches the loop's activation, but
        // the terminal it would interrupt is uninterruptible: the delivery
        // completes exactly once and the queue releases — there is no live
        // continuation the stop could tear down.
        const stop = session.runs.stop(runId, { reason: 'user' });
        expect(stop.accepted()).toBe(true);

        yield* Deferred.succeed(deliveryGate, undefined);
        yield* Fiber.join(loop);
        expect(mocks.startFollowUpWake).toHaveBeenCalledTimes(1);
        expect(session.runs.get(runId)?.live === true).toBe(false);
        yield* stop.settlement;
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
            return true;
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
          Effect.as(Deferred.succeed(firstDelivered, undefined), true),
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

  it.effect(
    'an application-level failure (isTurnError, not thrown) also delivers formatError and stops the run',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, resolveTurn } = createFakeStrategy();

        const loop = yield* startLoop(runId, strategy);

        yield* resolveTurn(1, { kind: 'error-turn', value: 'oops' });

        yield* Fiber.join(loop);
        expect(yield* queuedTexts(PARENT_RUN_ID)).toEqual(['error:oops']);
        expect(session.runs.get(runId)?.live === true).toBe(false);
      }),
  );

  // The loop's own stop observation is the one precedence authority: a stop
  // that reached the run before its exit outranks the turn's own report
  // (`stopped` on `finalizeRunTerminal`), so the terminal row says cancelled
  // even though the turn failed first.
  it.effect(
    'lets a stop landing after a turn failure win the terminal outcome',
    () =>
      Effect.gen(function* () {
        const runId = 'fa11ed01' as RunId;
        publishTestRunStart(session, runId, { parent: PARENT_RUN_ID });
        const { strategy, rejectTurn } = createFakeStrategy();
        // Fires once the failed turn settled, before the loop's finalize: the
        // window the stop latch has to win. Kill admission is synchronous, so
        // the stop latch is already set here and only the settlement is left
        // for the test to run once the loop is done.
        const stopSettlements: Effect.Effect<void, Error>[] = [];
        const interruptAfterFailure = vi.fn(() => {
          stopSettlements.push(
            session.runs.stop(runId, { reason: 'user' }).settlement,
          );
        });

        const loop = yield* startLoop(runId, strategy, {
          agentName: 'fake-cli',
          onTurnSettled: interruptAfterFailure,
        });

        yield* rejectTurn(1, new Error('turn blew up'));
        yield* Fiber.join(loop);
        expect(session.runs.get(runId)?.live === true).toBe(false);

        yield* Effect.all(stopSettlements, { discard: true });
        expect(interruptAfterFailure).toHaveBeenCalledOnce();
        // Error facts classified for a failure the stop outranked are not
        // facts about this run's outcome.
        const end = yield* getRunRecords(session, runId).readRunEnd();
        expect(end).toMatchObject({ outcome: RUN_OUTCOME.CANCELLED });
        expect(end?.error).toBeUndefined();
      }),
  );

  it.effect(
    'gates budgeted child turns through the budget, and a stop the slot wait',
    () =>
      Effect.gen(function* () {
        const config = testWorkspaceRoots().config as FakeConfigProvider;
        config.set(CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY, 1);
        try {
          const first = loopRunId();
          const second = loopRunId();
          const started: string[] = [];
          const firstStarted = yield* Deferred.make<void>();
          const firstRelease = yield* Deferred.make<FakeTurn>();

          // Native children, each turn under the run's permit.
          const budgeted = (
            stageLabel: string,
            turn: Effect.Effect<FakeTurn>,
          ): NativeChildStrategy<FakeTurn> => ({
            stageLabel,
            launch: (_ports, turns) => turns.turnPermit(turn),
            formatDelivery: (done) => Effect.succeed(`delivered:${done.value}`),
            formatError: () => 'error',
          });
          const firstLoop = yield* startNativeLoop(
            first,
            budgeted(
              'Budgeted first child',
              Effect.gen(function* () {
                started.push('first');
                yield* Deferred.succeed(firstStarted, undefined);
                return yield* Deferred.await(firstRelease);
              }),
            ),
            true,
          );
          const secondLoop = yield* startNativeLoop(
            second,
            budgeted(
              'Budgeted second child',
              Effect.sync((): FakeTurn => {
                started.push('second');
                return { kind: 'terminal', value: 'done' };
              }),
            ),
            true,
          );

          yield* Deferred.await(firstStarted);
          // One slot: the second child's turn must not start while the first
          // holds it, although its generation is live.
          expect(session.runs.get(second)?.live === true).toBe(true);
          // The loop offers no in-fiber hook for "parked on the permit", so one
          // macrotask is the window this negative assertion needs.
          yield* settle;
          expect(started).toEqual(['first']);

          // A stop while it waits for the slot settles it at once, although
          // the first child still holds the slot.
          yield* stopChildRun(second);
          yield* Fiber.await(secondLoop);
          expect(started).toEqual(['first']);

          yield* Deferred.succeed<FakeTurn, never>(firstRelease, {
            kind: 'terminal',
            value: 'done',
          });
          yield* Fiber.join(firstLoop);
        } finally {
          config.set(
            CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
            CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue,
          );
        }
      }),
  );
});
