// Test composition imports
import '@test/support/defaultSessionTestSetup';

// E2E fixtures for the promoted "one loop, N strategies" child-run driver.
// These exercise the loop's own mechanics (queue acquire/drain, one
// run-handle interrupt target for the child's whole lifetime, per-turn delivery, terminal
// finalize) against a minimal fake strategy — the same contract every real
// strategy (codex, claude, native subagent, workflow-script) implements.
// Identical assertions apply regardless of which strategy is plugged in,
// since delivery/interrupt/terminal choreography all live in the loop.

import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  finalizeRun: vi.fn(),
  submitFollowUp: vi.fn(),
  persistChildRunDelivery: vi.fn(),
  releaseRunLeaseAfterArtifacts: vi.fn(
    async (_session: unknown, _runId: RunId) => {},
  ),
}));

// Turn attribution is committed as `child.turn` rows on the run aggregate,
// so the fixtures read it back through the fold rather than a store mock.
vi.mock('@agent/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage')>()),
  finalizeRun: mocks.finalizeRun,
}));
// The registry deep-imports finalizeRun from runLifecycle.
vi.mock('@agent/storage/runLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage/runLifecycle')>()),
  finalizeRun: mocks.finalizeRun,
}));

vi.mock('@agent/followUp/ToolUseFollowUp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/followUp/ToolUseFollowUp')>()),
  submitFollowUp: mocks.submitFollowUp,
}));

vi.mock(
  '@agent/storage/childRunDeliveryPersistence',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@agent/storage/childRunDeliveryPersistence')
    >()),
    persistChildRunDelivery: mocks.persistChildRunDelivery,
  }),
);

import { getRunRecords } from '@agent/storage';
import { readChildTurnState } from '@agent/storage/runRecords';
import type { WorkflowJournalEntry } from '@agent/workflowScript/types';
const { submitFollowUp: realSubmitFollowUp } = await vi.importActual<
  typeof import('@agent/followUp/ToolUseFollowUp')
>('@agent/followUp/ToolUseFollowUp');
const { persistChildRunDelivery: realPersistChildRunDelivery } =
  await vi.importActual<
    typeof import('@agent/storage/childRunDeliveryPersistence')
  >('@agent/storage/childRunDeliveryPersistence');
import {
  startChildRunLoop,
  type ChildRunLoopParams,
  type ChildRunPorts,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { Runs } from '@agent/runtime/runRegistry';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentResume } from '@platform/interfaces';
import {
  aggregateId as qualifyAggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  AgentCategory,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
} from '@shared/schemas';
import { DatabaseNotOwner } from '@shared/session/database';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  createProcessSession,
  publishTestRunStart,
  queuedFollowUps,
} from '@test/support/sessionTestUtils';
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { AgentCliSessionRegistry } from '@tools/agentCliSessionRegistry';
import {
  claudeAgentSessionsFor,
  codexThreadsFor,
} from '@tools/agentCliSessionStores';
import { createChildRun } from '@tools/delegation/childRun';
import { createWorkflowAttemptCostTracker } from '@tools/delegation/workflowScriptRun';
import { generateRunId } from '@utils/core';

let session: SessionHandle;
const trackedRunIds = new Set<RunId>();

const childRunConfig = {
  agentCategory: AgentCategory.ToolUse,
  model: 'test-model',
  agent: 'fake-cli',
} as unknown as AgentConfig;

const PARENT_RUN_ID = 'ffff01' as RunId;

/** The run id a fixture drives, with its `run.start` already committed. */
function loopRunId(): RunId {
  const runId = generateRunId();
  publishTestRunStart(session, runId);
  return runId;
}

function trackChildHandle(runId: RunId, parentRunId: RunId): RunHandle {
  const handle = testRunHandle({
    runId,
    parent: parentRunId,
    agent: 'fake',
    trace: { emit: vi.fn() } as never,
  });
  session.runs.track(handle);
  trackedRunIds.add(runId);
  return handle;
}

/**
 * Move the parent run's folded phase, the way the runtime does: an
 * activation row makes it running, the terminal row ends it. The fold is
 * the one phase authority, so a follow-up test states its premise in rows.
 */
const foldParentPhase = (active: boolean) =>
  Effect.gen(function* () {
    const aggregateId = qualifyAggregateId('run', PARENT_RUN_ID);
    session.publish([
      active
        ? {
            type: 'run.activate',
            aggregateId,
            category: AgentCategory.ToolUse,
            isRemote: false,
          }
        : {
            type: 'run.end',
            aggregateId,
            outcome: RUN_OUTCOME.COMPLETED,
            output: emptyRunEndOutput(AgentCategory.ToolUse),
          },
    ]);
    yield* session.settlePublications();
  });

/** The text of each follow-up a run's rows still queue. */
const queuedTexts = (runId: RunId) =>
  Effect.map(queuedFollowUps(session, runId), (followUps) =>
    followUps.map((followUp) => followUp.text),
  );

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
  readonly strategy: ChildRunStrategy<FakeTurn>;
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

  const strategy: ChildRunStrategy<FakeTurn> = {
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
  formatDelivery: ChildRunStrategy<FakeTurn>['formatDelivery'] = (turn) =>
    Effect.succeed(`delivered:${turn.value}`),
): ChildRunStrategy<FakeTurn> {
  return {
    stageLabel,
    launch,
    isTerminal: () => true,
    formatDelivery,
    formatError: () => 'error',
  };
}

/**
 * Start the loop with the fixture defaults; extras override any param. Setup
 * is synchronous through the queue claim, so the loop owns the run's queue by
 * the time the returned fiber is in hand; the fiber itself is detached, so
 * every test joins it before its body ends.
 */
const startLoop = (
  runId: RunId,
  strategy: ChildRunStrategy<FakeTurn>,
  extras: Partial<ChildRunLoopParams<FakeTurn>> = {},
) =>
  startChildRunLoop({
    session,
    runId,
    parentRunId: PARENT_RUN_ID,
    agentName: 'fake',
    strategy,
    ...extras,
  }).pipe(
    Effect.provideService(Runs, session.runs),
    // No host resume in these fixtures: the port declines every wake.
    Effect.provideService(AgentResume, {
      tryResumeRun: () => Effect.succeed(false),
    }),
  );

beforeEach(async () => {
  session = await Effect.runPromise(createProcessSession());
  publishTestRunStart(session, PARENT_RUN_ID);
  await Effect.runPromise(session.settlePublications());
  vi.clearAllMocks();
  // The loop's terminal drain is the session's one exit choreography; the
  // suite observes it through the same (session, runId) spy as before.
  vi.spyOn(session, 'releaseRunLease').mockImplementation((runId) =>
    Effect.promise(() => mocks.releaseRunLeaseAfterArtifacts(session, runId)),
  );
  mocks.finalizeRun.mockReturnValue(Effect.succeed({ ok: true }));
  mocks.submitFollowUp.mockReturnValue(Effect.succeed({ status: 'sent' }));
  mocks.persistChildRunDelivery.mockImplementation(realPersistChildRunDelivery);
});

afterEach(() => {
  for (const runId of trackedRunIds) {
    session.runs.untrack(runId);
  }
  trackedRunIds.clear();
});

describe('childRunLoop E2E fixtures', () => {
  it.effect(
    'a turn refused as DatabaseNotOwner stops the loop instead of taking another turn',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, callCount, rejectTurn, turnStarted } =
          createFakeStrategy();
        trackChildHandle(runId, PARENT_RUN_ID);

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
        expect(session.runs.getHandle(runId)).toBeUndefined();
      }),
  );

  it.effect(
    'unwinds provider ownership and loop resources when synchronous setup fails',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const registry = new AgentCliSessionRegistry(session.runs);
        const releaseSessionOwnership = vi.fn(() =>
          registry.releaseByRunId(runId),
        );
        const handle = trackChildHandle(runId, PARENT_RUN_ID);
        const interruptHandle = vi.spyOn(handle, 'interrupt');
        const registerLoop = vi
          .spyOn(session.followUps, 'claimChildRun')
          .mockImplementationOnce(() => {
            throw new Error('loop registration failed');
          });
        const { strategy } = createFakeStrategy();

        try {
          const error = yield* Effect.flip(
            startLoop(
              runId,
              {
                ...strategy,
                onLoopStart: () => {
                  registry.trackInFlight({ runId });
                },
                releaseSessionOwnership,
              },
              { agentName: 'fake-cli' },
            ),
          );
          expect(error.message).toContain('loop registration failed');

          expect(releaseSessionOwnership).toHaveBeenCalledOnce();
          expect(session.followUps.hasLiveOwner(runId)).toBe(false);
          expect(handle.interrupt()).toBe(false);
          interruptHandle.mockClear();
          registry.interruptAll();
          expect(interruptHandle).not.toHaveBeenCalled();
          expect(yield* queuedFollowUps(session, runId)).toEqual([]);
        } finally {
          registerLoop.mockRestore();
          interruptHandle.mockRestore();
          registry.releaseByRunId(runId);
        }
      }),
  );

  it.effect(
    'admits a follow-up submitted during startup into the seeded queue',
    () =>
      Effect.gen(function* () {
        // The queue claim precedes the seed's aggregate read, so a submission
        // landing inside that read is held for the seed instead of being
        // refused against a child the registry already shows active, or
        // committing behind the snapshot the seed reads.
        const runId = loopRunId();
        const { strategy, resolveTurn, turnStarted } = createFakeStrategy();
        const childRun = yield* createChildRun(session, runId, PARENT_RUN_ID, {
          run: { kind: 'agent', agent: 'fake-cli', tool: 'codex' },
          userFollowUpSupport: 'terminalBacked',
          description: 'Keep an agent-CLI child running',
          config: childRunConfig,
        }).pipe(Effect.provideService(Runs, session.runs));
        trackedRunIds.add(runId);

        const readStarted = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        const readAggregate = session.readAggregate.bind(session);
        const gate = vi
          .spyOn(session, 'readAggregate')
          .mockImplementationOnce((id) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(readStarted, undefined);
              yield* Deferred.await(releaseRead);
              return yield* readAggregate(id);
            }),
          );
        try {
          const starter = yield* Effect.forkScoped(
            startLoop(runId, strategy, { childRun }),
          );
          yield* Deferred.await(readStarted);
          expect(
            yield* session.followUps.submit(
              runId,
              { text: 'early', origin: 'user' },
              'live_owner',
            ),
          ).toEqual({ kind: 'queued' });
          yield* Deferred.succeed(releaseRead, undefined);
          const loop = yield* Fiber.join(starter);

          yield* resolveTurn(1, { kind: 'interim', value: 'first' });
          // Only the seeded follow-up starts a second turn.
          yield* turnStarted(2);
          yield* resolveTurn(2, { kind: 'terminal', value: 'final' });
          yield* Fiber.join(loop);
        } finally {
          gate.mockRestore();
        }
      }),
  );

  it.effect.each([
    {
      name: 'CodexThreads',
      track: (runId: RunId, runSession: SessionHandle) =>
        codexThreadsFor(runSession.runs).trackInFlight({ runId }),
      interruptAll: () => codexThreadsFor(session.runs).interruptAll(),
      release: (runId: RunId) =>
        codexThreadsFor(session.runs).releaseByRunId(runId),
    },
    {
      name: 'ClaudeAgentSessions',
      track: (runId: RunId, runSession: SessionHandle) =>
        claudeAgentSessionsFor(runSession.runs).trackInFlight({ runId }),
      interruptAll: () => claudeAgentSessionsFor(session.runs).interruptAll(),
      release: (runId: RunId) =>
        claudeAgentSessionsFor(session.runs).releaseByRunId(runId),
    },
  ])(
    '$name interrupts a real initial-turn loop and releases ownership once',
    ({ name, track, interruptAll, release }) =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const events: string[] = [];
        const aborted = vi.fn();
        const releaseSessionOwnership = vi.fn(() => release(runId));
        trackChildHandle(runId, PARENT_RUN_ID);
        const launched = yield* Deferred.make<void>();

        const strategy: ChildRunStrategy<FakeTurn> = {
          stageLabel: `${name} session`,
          launch: (_ports, signal) =>
            Effect.gen(function* () {
              events.push('launch');
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
          onLoopStart: (runSession) => {
            events.push('registered');
            track(runId, runSession);
          },
          releaseSessionOwnership,
        };

        try {
          const loop = yield* startLoop(runId, strategy, {
            agentName: name,
          });

          expect(events).toEqual(['registered']);
          expect(session.followUps.hasLiveOwner(runId)).toBe(true);
          // The loop body is a generation on the run's lane: it starts
          // once the lane admits it, not inside `startChildRunLoop`.
          yield* Deferred.await(launched);
          expect(events).toEqual(['registered', 'launch']);
          interruptAll();

          yield* Fiber.join(loop);
          expect(aborted).toHaveBeenCalledOnce();
          expect(session.followUps.hasLiveOwner(runId)).toBe(false);
          expect(releaseSessionOwnership).toHaveBeenCalledOnce();
          expect(session.runs.getHandle(runId)).toBeUndefined();
        } finally {
          release(runId);
        }
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
          active: { attemptId: expect.any(String), turnIndex: 1 },
          lastCompleted: null,
        });
        expect(mocks.releaseRunLeaseAfterArtifacts).not.toHaveBeenCalled();

        // Interrupt the loop through its parent lineage: no turn handle is
        // tracked in this fixture, so the stop reaches the loop via its
        // child activation.
        const stopping = yield* Effect.forkChild(
          session.runs.stopAgentRun(PARENT_RUN_ID),
          { startImmediately: true },
        );
        yield* rejectTurn(1, createAbortError());
        yield* Fiber.join(stopping);
        yield* Fiber.join(loop);

        // An interrupted turn never settles, so the acceptance row stands and
        // the lease is released only once the loop is done with it.
        expect(yield* readChildTurnState(session, runId)).toEqual({
          active: { attemptId: expect.any(String), turnIndex: 1 },
          lastCompleted: null,
        });
        expect(mocks.releaseRunLeaseAfterArtifacts).toHaveBeenCalledWith(
          session,
          runId,
        );
      }),
  );

  it.effect(
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
        publishTestRunStart(session, runId);
        const childRun = yield* createChildRun(session, runId, PARENT_RUN_ID, {
          run: { kind: 'agent', agent: 'fake-cli', tool: 'codex' },
          userFollowUpSupport: 'terminalBacked',
          description: 'Keep a background child running',
          config: childRunConfig,
        }).pipe(Effect.provideService(Runs, session.runs));
        trackedRunIds.add(runId);
        const loop = yield* startLoop(runId, strategy, {
          childRun,
        });
        const tryResumeRun = vi.fn(() => Effect.succeed(false));
        yield* Deferred.await(launchStarted);

        try {
          yield* foldParentPhase(true);
          expect(
            yield* realSubmitFollowUp(PARENT_RUN_ID, 'active parent', {
              session,
            }).pipe(Effect.provideService(AgentResume, { tryResumeRun })),
          ).toEqual({ status: 'queued', wake: 'failed' });

          yield* foldParentPhase(false);
          const userAdmission = vi.fn();
          expect(
            yield* realSubmitFollowUp(PARENT_RUN_ID, 'restore me', {
              session,
              onAdmitted: userAdmission,
            }).pipe(Effect.provideService(AgentResume, { tryResumeRun })),
          ).toMatchObject({ status: 'failed' });
          expect(userAdmission).toHaveBeenCalledWith(false);
          expect(
            yield* realSubmitFollowUp(
              PARENT_RUN_ID,
              { text: 'late child result', origin: 'subagent_result' },
              { session },
            ).pipe(Effect.provideService(AgentResume, { tryResumeRun })),
          ).toMatchObject({ status: 'failed' });
          expect(yield* queuedTexts(PARENT_RUN_ID)).toEqual(['active parent']);

          const releaseNativeChild = session.runs.reserveChildActivation({
            runId: 'da7a01' as RunId,
            parentRunId: PARENT_RUN_ID,
            interrupt: vi.fn(),
            detach: vi.fn(),
            isDetached: () => false,
          });
          try {
            expect(
              yield* realSubmitFollowUp(PARENT_RUN_ID, 'native child result', {
                session,
              }).pipe(Effect.provideService(AgentResume, { tryResumeRun })),
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
              const queued = await Effect.runPromise(
                queuedTexts(PARENT_RUN_ID),
              );
              expect(queued).toHaveLength(terminalQueue.length + 1);
              return queued;
            }),
          );

          yield* Deferred.succeed<FakeTurn, Error>(turn, {
            kind: 'terminal',
            value: 'done',
          });
          yield* Deferred.await(formatStarted);
          yield* session.runs.detachActiveChildren(PARENT_RUN_ID);
          notifyProgress({ kind: 'started' });
          yield* Deferred.succeed(formattedDelivery, 'delivered:done');
          yield* Fiber.join(loop);

          expect(yield* queuedTexts(PARENT_RUN_ID)).toEqual(progressQueue);
          expect(mocks.submitFollowUp).not.toHaveBeenCalled();
        } finally {
          session.followUps.terminalize(PARENT_RUN_ID);
          yield* session.runs.detachActiveChildren(PARENT_RUN_ID);
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
      expect(mocks.submitFollowUp).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'reuses a terminal child stream for a separately authorized retry',
    () =>
      Effect.gen(function* () {
        const retryRunId = loopRunId();
        const parentLease = session.followUps.claimLive(PARENT_RUN_ID, 'flow')!;
        const admissions: string[] = [];
        mocks.submitFollowUp.mockImplementation(
          (targetRunId, followUp, options) =>
            Effect.gen(function* () {
              const admission = yield* options.session.followUps.submit(
                targetRunId,
                followUp,
                'live_owner',
              );
              admissions.push(admission.kind);
              return admission.kind === 'duplicate' ||
                admission.kind === 'refused'
                ? {
                    status: 'failed' as const,
                    reason: 'not_resumable' as const,
                  }
                : { status: 'sent' as const };
            }),
        );

        try {
          yield* Fiber.join(
            yield* startLoop(
              retryRunId,
              createTerminalStrategy('First attempt'),
            ),
          );
          expect(session.followUps.hasLiveOwner(retryRunId)).toBe(false);

          expect(
            yield* Fiber.join(
              yield* startLoop(
                retryRunId,
                createTerminalStrategy('Retry attempt'),
              ),
            ),
          ).toBeUndefined();
          expect(admissions).toEqual(['duplicate', 'duplicate']);
          const delivered = yield* queuedFollowUps(session, PARENT_RUN_ID);
          expect(delivered.map((item) => item.text)).toEqual([
            'delivered:done',
            'delivered:done',
          ]);
          expect(delivered[1]?.followUpId).not.toBe(delivered[0]?.followUpId);
          expect(session.followUps.hasLiveOwner(retryRunId)).toBe(false);
        } finally {
          session.followUps.release(parentLease, 'recoverable');
        }
      }),
  );

  it.effect('releases session ownership before delivering a failed turn', () =>
    Effect.gen(function* () {
      const runId = loopRunId();
      const { strategy, rejectTurn } = createFakeStrategy();
      const releaseSessionOwnership = vi.fn();
      // The in-mock assertion now fails the delivery as a defect rather than
      // being swallowed by a rejected promise the loop logs.
      mocks.submitFollowUp.mockImplementation(() =>
        Effect.sync(() => {
          expect(releaseSessionOwnership).toHaveBeenCalledOnce();
          return { status: 'sent' };
        }),
      );

      const loop = yield* startLoop(
        runId,
        { ...strategy, releaseSessionOwnership },
        { agentName: 'fake-cli' },
      );

      expect(session.followUps.hasLiveOwner(runId)).toBe(true);
      yield* rejectTurn(1, new Error('initial turn failed'));
      yield* Fiber.join(loop);
      expect(session.followUps.hasLiveOwner(runId)).toBe(false);
      expect(releaseSessionOwnership).toHaveBeenCalledOnce();
    }),
  );

  it.effect(
    'delegate → interrupt mid-run: an interrupt during the first turn ends the run without a terminal delivery for that turn',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, rejectTurn, turnStarted } = createFakeStrategy();
        const handle = trackChildHandle(runId, PARENT_RUN_ID);

        const loop = yield* startLoop(runId, strategy);

        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        yield* turnStarted(1);

        expect(handle.interrupt()).toBe(true);
        // Simulate the in-flight call failing with an AbortError-shaped
        // failure, matching what a real strategy's abortController produces.
        yield* rejectTurn(1, createAbortError());

        yield* Fiber.join(loop);
        expect(mocks.submitFollowUp).not.toHaveBeenCalled();
        expect(session.runs.getHandle(runId)).toBeUndefined();
      }),
  );

  it.effect(
    'delegate → complete → follow-up delivery: an interim turn delivers, then the loop picks up a queued follow-up for the next turn',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, callCount, resolveTurn, turnStarted } =
          createFakeStrategy();
        const onLoopStart = vi.fn();
        const onTurnSuccess = vi.fn();
        const parentWake = vi.fn();
        const deliveryStarted = yield* Deferred.make<void>();
        const deliveryCompleted = yield* Deferred.make<void>();
        mocks.submitFollowUp.mockImplementation(() =>
          Effect.gen(function* () {
            parentWake();
            yield* Deferred.succeed(deliveryStarted, undefined);
            yield* Deferred.await(deliveryCompleted);
            return { status: 'sent' as const };
          }),
        );

        const loop = yield* startLoop(runId, {
          ...strategy,
          onLoopStart,
          onTurnSuccess,
        });

        expect(onLoopStart).toHaveBeenCalledOnce();
        expect(onLoopStart).toHaveBeenCalledWith(session);
        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        yield* resolveTurn(1, { kind: 'interim', value: 'first' });

        yield* Deferred.await(deliveryStarted);
        expect(mocks.submitFollowUp).toHaveBeenCalledWith(
          PARENT_RUN_ID,
          expect.objectContaining({ text: 'delivered:first' }),
          expect.anything(),
        );
        // The loop starts delivery for turn N before reading the queue for turn
        // N+1. Even input already queued during delivery must not begin another
        // model turn until the parent has received this result.
        expect(onTurnSuccess).toHaveBeenCalledOnce();
        expect(onTurnSuccess.mock.invocationCallOrder[0]).toBeLessThan(
          parentWake.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );

        // Enqueue a follow-up on the same queue the loop is now blocked on.
        expect(
          yield* session.followUps.submit(
            runId,
            { text: 'keep going', origin: 'user' },
            'live_owner',
          ),
        ).toEqual({ kind: 'queued' });
        expect(callCount()).toBe(1);

        yield* Deferred.succeed(deliveryCompleted, undefined);
        // Waits for the loop to have actually invoked runTurn a second time —
        // NOT for the queue to read empty, which can happen synchronously on
        // enqueue (the fast "someone is already waiting" path never pushes to
        // the backing array at all) well before the loop's own continuation runs.
        yield* turnStarted(2);
        yield* resolveTurn(2, { kind: 'terminal', value: 'final' });

        yield* Fiber.join(loop);
        expect(mocks.submitFollowUp).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ text: 'delivered:final' }),
          expect.anything(),
        );
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);
      }),
  );

  // it.live: the WAITING status is the session fold projecting the waiting row
  // that `commitFlowStep` commits after delivery returns, and the loop offers
  // no in-fiber hook between the two, so the one surviving poll observes a
  // process-runtime fact under the live clock.
  it.live(
    'parks a child-stream loop on a waiting row, so the next turn is admitted onto its queue',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, resolveTurn, turnStarted } = createFakeStrategy();
        const childRun = yield* createChildRun(session, runId, PARENT_RUN_ID, {
          run: { kind: 'agent', agent: 'fake-cli', tool: 'codex' },
          userFollowUpSupport: 'terminalBacked',
          description: 'Keep an agent-CLI child running',
          config: childRunConfig,
        }).pipe(Effect.provideService(Runs, session.runs));
        trackedRunIds.add(runId);
        const loop = yield* startLoop(runId, strategy, { childRun });

        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        yield* resolveTurn(1, { kind: 'interim', value: 'first' });

        // Blocked between turns the run is idle, and the phase row says so: a
        // run that only looked busy is refused as `no_session` and its session
        // can never take another turn.
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(session.runView(runId)?.status).toBe(RUN_PHASE.WAITING),
          ),
        );
        expect(session.runs.getToolUseFollowUpTarget(runId)).toEqual({
          kind: 'queue',
        });

        yield* session.followUps.submit(
          runId,
          { text: 'keep going', origin: 'user' },
          'live_owner',
        );
        yield* turnStarted(2);
        yield* session.settlePublications();
        expect(session.runView(runId)?.status).toBe(RUN_PHASE.RUNNING);
        yield* resolveTurn(2, { kind: 'terminal', value: 'final' });
        yield* Fiber.join(loop);
      }),
  );

  it.effect(
    'keeps a consumed prompt queued when the turn result fails to persist',
    () =>
      Effect.gen(function* () {
        // The settle row still commits (it is the re-execution gate), but the
        // prompt's `followup.consumed` rows must not: with no report and no
        // parent row durable, consuming them would lose the completed turn,
        // so the relaunched loop seeds the prompt and runs it again.
        const runId = loopRunId();
        const { strategy, resolveTurn, turnStarted } = createFakeStrategy();
        const childRun = yield* createChildRun(session, runId, PARENT_RUN_ID, {
          run: { kind: 'agent', agent: 'fake-cli', tool: 'codex' },
          userFollowUpSupport: 'terminalBacked',
          description: 'Keep an agent-CLI child running',
          config: childRunConfig,
        }).pipe(Effect.provideService(Runs, session.runs));
        trackedRunIds.add(runId);
        const loop = yield* startLoop(runId, strategy, { childRun });

        yield* resolveTurn(1, { kind: 'interim', value: 'first' });
        yield* session.followUps.submit(
          runId,
          { text: 'keep going', origin: 'user' },
          'live_owner',
        );
        yield* turnStarted(2);

        mocks.persistChildRunDelivery.mockImplementation(() =>
          Effect.fail(new Error('disk full')),
        );
        yield* resolveTurn(2, { kind: 'terminal', value: 'final' });

        expect(Exit.isFailure(yield* Fiber.await(loop))).toBe(true);
        expect(yield* queuedTexts(runId)).toEqual(['keep going']);
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);
      }),
  );

  it.effect(
    'late result after parent stop: a turn that resolves after interruption is persisted but not delivered',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, resolveTurn, turnStarted } = createFakeStrategy();
        const handle = trackChildHandle(runId, PARENT_RUN_ID);
        const releaseSessionOwnership = vi.fn();
        const loop = yield* startLoop(runId, {
          ...strategy,
          releaseSessionOwnership,
        });

        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        yield* turnStarted(1);
        // Interrupt the loop, then let the in-flight turn resolve normally
        // (not aborted) — mirrors a turn that was already past its own
        // interruption checkpoints when the stop landed.
        expect(handle.interrupt()).toBe(true);
        yield* resolveTurn(1, { kind: 'terminal', value: 'late' });

        yield* Fiber.join(loop);
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);
        expect(yield* getRunRecords(session, runId).readReport()).toBe(
          'delivered:late',
        );
        expect(releaseSessionOwnership).toHaveBeenCalledOnce();
        expect(mocks.submitFollowUp).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'kill during WAITING: interrupting the loop while it is blocked between turns ends the run without a hang',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, resolveTurn } = createFakeStrategy();
        const handle = trackChildHandle(runId, PARENT_RUN_ID);
        const delivered = yield* Deferred.make<void>();
        mocks.submitFollowUp.mockImplementation(() =>
          Effect.as(Deferred.succeed(delivered, undefined), { status: 'sent' }),
        );

        const loop = yield* startLoop(runId, strategy);

        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        yield* resolveTurn(1, { kind: 'interim', value: 'first' });

        yield* Deferred.await(delivered);
        // One macrotask lets the loop enter its queue wait; either way
        // the loop ends with exactly one delivery.
        yield* settle;
        // The loop is now blocked in its queue wait; the loop's handler on
        // the run handle is the live stop target.
        expect(handle.interrupt()).toBe(true);

        yield* Fiber.join(loop);
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);
        // Only the one interim delivery — the kill did not spawn another turn.
        expect(mocks.submitFollowUp).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect(
    'stop between turns settles the ghost handle when terminal metadata fails',
    () =>
      Effect.gen(function* () {
        // Regression: for a native strategy (no ChildRun — each turn owns its
        // own RunHandle via runFlowWithLifecycle, not the loop), a
        // stop landing BETWEEN turns interrupts the loop through the run handle
        // and transitions the stream to CANCELLED — but assumes a live flow will
        // notice and self-finalize.
        // Nothing is running here (the loop is just blocked on a queue wait), so
        // without the loop's own finalize-on-interrupt fallback, the most
        // recently tracked handle for this stream — still WAITING, still
        // resumable-looking — would never settle or untrack.
        const runId = loopRunId();
        const { strategy, resolveTurn } = createFakeStrategy();
        const delivered = yield* Deferred.make<void>();
        mocks.submitFollowUp.mockImplementation(() =>
          Effect.as(Deferred.succeed(delivered, undefined), { status: 'sent' }),
        );
        mocks.finalizeRun.mockReturnValueOnce(
          Effect.succeed({
            ok: false,
            error: new Error('metadata disk full'),
            outcomePersisted: false,
          }),
        );

        const loop = yield* startLoop(runId, strategy);

        expect(session.followUps.hasLiveOwner(runId)).toBe(true);

        // Mirrors what a real native turn's runFlowWithLifecycle does: track a
        // fresh handle for this run once the turn suspends.
        const handle = trackChildHandle(runId, PARENT_RUN_ID);

        yield* resolveTurn(1, { kind: 'interim', value: 'first' });
        yield* Deferred.await(delivered);
        expect(mocks.submitFollowUp).toHaveBeenCalledTimes(1);
        // One macrotask lets the loop reach its queue wait before the stop lands.
        yield* settle;

        // Loop is now between turns. Interrupt it through the run handle.
        expect(handle.interrupt()).toBe(true);

        yield* Fiber.join(loop);
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);

        // Untracked: no longer resumable — a later delegate_agent(execution_id=…)
        // would correctly report "not found" instead of finding a ghost handle.
        expect(session.runs.getHandle(runId)).toBeUndefined();
        // The loop routes the cancellation through the durable outcome's only
        // writer; the interim result envelope is left exactly as its turn wrote
        // it, and reads project the durable outcome onto it.
        expect(mocks.finalizeRun).toHaveBeenCalledWith(session, {
          runId,
          outcome: RUN_OUTCOME.CANCELLED,
          error: undefined,
          usage: undefined,
          output: { category: 'toolUse', response: '', files: [] },
        });
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
        const handle = trackChildHandle(runId, PARENT_RUN_ID);
        const deliveryStarted = yield* Deferred.make<void>();
        const deliveryGate = yield* Deferred.make<void>();
        mocks.submitFollowUp.mockImplementation(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(deliveryStarted, undefined);
            yield* Deferred.await(deliveryGate);
            return { status: 'sent' as const };
          }),
        );

        const strategy = createTerminalStrategy('Reregister test');

        const loop = yield* startLoop(runId, strategy);

        // Wait until delivery is mid-flight (blocked on our gate).
        yield* Deferred.await(deliveryStarted);

        expect(handle.interrupt()).toBe(false);

        yield* Deferred.succeed(deliveryGate, undefined);
        yield* Fiber.join(loop);
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);
      }),
  );

  it.effect(
    '#8093 regression: a terminal turn finalizes this child before its wake step is even reached, so a resumed parent never self-stalls waiting on it',
    () =>
      Effect.gen(function* () {
        // Regression: parent continuation submission can await the ENTIRE resumed
        // turn (`agentResume.tryResumeRun` → … → `resumeToolUseFromResumeData`).
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
        trackChildHandle(runId, PARENT_RUN_ID);

        const wakeReached = yield* Deferred.make<void>();
        const releaseWake = yield* Deferred.make<void>();
        let handleAtWakeTime: unknown;
        mocks.submitFollowUp.mockImplementation(() =>
          Effect.gen(function* () {
            // Snapshot registry state the instant the wake step is reached. The
            // same moment a resumed parent's own turn would begin running.
            handleAtWakeTime = session.runs.getHandle(runId);
            yield* Deferred.succeed(wakeReached, undefined);
            yield* Deferred.await(releaseWake);
            return { status: 'sent' as const };
          }),
        );

        const strategy = createTerminalStrategy('Finalize-before-wake test');

        const loop = yield* startLoop(runId, strategy);

        yield* Deferred.await(wakeReached);
        expect(handleAtWakeTime).toBeUndefined();
        expect(session.runs.getHandle(runId)).toBeUndefined();

        yield* Deferred.succeed(releaseWake, undefined);
        yield* Fiber.join(loop);
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);
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
        mocks.submitFollowUp.mockImplementation(() =>
          Effect.as(Deferred.succeed(firstDelivered, undefined), {
            status: 'sent',
          }),
        );

        const loop = yield* startLoop(runId, strategy);

        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        yield* resolveTurn(1, { kind: 'interim', value: 'first' });
        yield* Deferred.await(firstDelivered);
        expect(mocks.submitFollowUp).toHaveBeenCalledTimes(1);

        expect(
          yield* session.followUps.submit(
            runId,
            { text: 'resume please', origin: 'user' },
            'live_owner',
          ),
        ).toEqual({ kind: 'queued' });

        const resumeFailure = new Error('resume storage unreadable');
        yield* rejectTurn(2, resumeFailure);

        yield* Fiber.join(loop);
        expect(mocks.submitFollowUp).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ text: 'error:thrown' }),
          expect.anything(),
        );
        expect(errors).toContain(resumeFailure);
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);
      }),
  );

  it.effect(
    'an application-level failure (isTurnError, not thrown) also delivers formatError and stops the run',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, resolveTurn } = createFakeStrategy();

        const loop = yield* startLoop(runId, strategy);

        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        yield* resolveTurn(1, { kind: 'error-turn', value: 'oops' });

        yield* Fiber.join(loop);
        expect(mocks.submitFollowUp).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ text: 'error:oops' }),
          expect.anything(),
        );
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);
      }),
  );

  it.effect(
    'finalizes a dangling native handle with non-null error metadata after a non-throwing turn failure',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const { strategy, resolveTurn } = createFakeStrategy();

        const loop = yield* startLoop(runId, strategy);

        expect(session.followUps.hasLiveOwner(runId)).toBe(true);

        trackChildHandle(runId, PARENT_RUN_ID);

        yield* resolveTurn(1, { kind: 'error-turn', value: 'oops' });

        yield* Fiber.join(loop);
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);
        expect(mocks.finalizeRun).toHaveBeenCalledWith(
          session,
          expect.objectContaining({
            runId,
            outcome: RUN_OUTCOME.FAILED,
            error: expect.objectContaining({
              message: expect.stringContaining('reported a failed turn'),
            }),
          }),
        );
        expect(session.runs.getHandle(runId)).toBeUndefined();
      }),
  );

  // The handle's stop latch is the one precedence authority
  // (`finalizeRunTerminal`): a stop that reached the run before its exit
  // outranks the turn's own report, so the terminal row says cancelled even
  // though the turn failed first.
  it.effect(
    'lets a stop landing after a turn failure win the terminal outcome',
    () =>
      Effect.gen(function* () {
        const runId = 'fa11ed01' as RunId;
        publishTestRunStart(session, runId);
        const childRun = yield* createChildRun(session, runId, PARENT_RUN_ID, {
          run: { kind: 'agent', agent: 'fake-cli', tool: 'codex' },
          userFollowUpSupport: 'terminalBacked',
          description: 'Fail a turn, then take an interrupt',
          config: childRunConfig,
        }).pipe(Effect.provideService(Runs, session.runs));
        trackedRunIds.add(runId);
        const { strategy, rejectTurn } = createFakeStrategy();
        // Fires between the turn failure and the loop's finalize, which is the
        // window the stop latch has to win. Kill admission is synchronous, so
        // the stop latch is already set here and only the settlement is left
        // for the test to run once the loop is done.
        const stopSettlements: Effect.Effect<void, Error>[] = [];
        const interruptAfterFailure = vi.fn(() => {
          stopSettlements.push(session.runs.kill(runId).settlement);
        });

        const loop = yield* startLoop(runId, strategy, {
          childRun,
          agentName: 'fake-cli',
          recordCost: interruptAfterFailure,
        });

        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        yield* rejectTurn(1, new Error('turn blew up'));
        yield* Fiber.join(loop);
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);

        yield* Effect.all(stopSettlements, { discard: true });
        expect(interruptAfterFailure).toHaveBeenCalledOnce();
        expect(mocks.finalizeRun).toHaveBeenCalledWith(
          session,
          expect.objectContaining({
            runId,
            outcome: RUN_OUTCOME.CANCELLED,
            // Error facts classified for a failure the stop outranked are not
            // facts about this run's outcome.
            error: undefined,
          }),
        );
      }),
  );

  it.effect(
    'gates budgeted child turns through the session child-run budget',
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

          const firstStrategy = createTerminalStrategy(
            'Budgeted first child',
            () =>
              Effect.gen(function* () {
                started.push('first');
                yield* Deferred.succeed(firstStarted, undefined);
                return yield* Deferred.await(firstRelease);
              }),
          );
          const secondStrategy = createTerminalStrategy(
            'Budgeted second child',
            () =>
              Effect.sync((): FakeTurn => {
                started.push('second');
                return { kind: 'terminal', value: 'done' };
              }),
          );

          const firstLoop = yield* startLoop(first, firstStrategy, {
            budgeted: true,
          });
          const secondLoop = yield* startLoop(second, secondStrategy, {
            budgeted: true,
          });

          yield* Deferred.await(firstStarted);
          // One slot: the second child's turn must not start while the first
          // holds it — even after its loop has acquired its queue lease.
          expect(session.followUps.hasLiveOwner(second)).toBe(true);
          // The loop offers no in-fiber hook for "parked on the permit", so one
          // macrotask is the window this negative assertion needs.
          yield* settle;
          expect(started).toEqual(['first']);

          yield* Deferred.succeed<FakeTurn, never>(firstRelease, {
            kind: 'terminal',
            value: 'done',
          });
          yield* Fiber.join(secondLoop);
          yield* Fiber.join(firstLoop);
          expect(started).toEqual(['first', 'second']);
        } finally {
          config.set(
            CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
            CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue,
          );
        }
      }),
  );

  it.effect(
    'recordCost commits exactly once with the greatest observed value',
    () =>
      Effect.gen(function* () {
        const runId = loopRunId();
        const firstTurn = yield* Deferred.make<FakeTurn>();
        const nextTurn = yield* Deferred.make<FakeTurn>();
        const recordCost = vi.fn();
        const firstDelivered = yield* Deferred.make<void>();
        mocks.submitFollowUp.mockImplementation(() =>
          Effect.as(Deferred.succeed(firstDelivered, undefined), {
            status: 'sent',
          }),
        );

        const strategy: ChildRunStrategy<FakeTurn> = {
          stageLabel: 'Fake cost-tracking run',
          launch: (ports: ChildRunPorts) =>
            Effect.gen(function* () {
              const turn = yield* Deferred.await(firstTurn);
              ports.recordCost(0.2);
              return turn;
            }),
          runTurn: (_items, ports: ChildRunPorts) =>
            Effect.gen(function* () {
              const turn = yield* Deferred.await(nextTurn);
              ports.recordCost(undefined);
              ports.recordCost(0.1);
              return turn;
            }),
          isTerminal: (turn) => turn.kind === 'terminal',
          formatDelivery: (turn) => Effect.succeed(`delivered:${turn.value}`),
          formatError: (turn) => `error:${turn?.value ?? 'thrown'}`,
        };

        const loop = yield* startLoop(runId, strategy, { recordCost });

        expect(session.followUps.hasLiveOwner(runId)).toBe(true);
        yield* Deferred.succeed<FakeTurn, never>(firstTurn, {
          kind: 'interim',
          value: 'first',
        });
        yield* Deferred.await(firstDelivered);
        expect(mocks.submitFollowUp).toHaveBeenCalledTimes(1);

        expect(
          yield* session.followUps.submit(
            runId,
            { text: 'go on', origin: 'user' },
            'live_owner',
          ),
        ).toEqual({ kind: 'queued' });
        yield* Deferred.succeed<FakeTurn, never>(nextTurn, {
          kind: 'terminal',
          value: 'final',
        });

        yield* Fiber.join(loop);
        expect(session.followUps.hasLiveOwner(runId)).toBe(false);
        expect(recordCost).toHaveBeenCalledTimes(1);
        expect(recordCost).toHaveBeenCalledWith(0.2);
      }),
  );

  it.effect('settles mixed workflow attempt spend to the parent once', () =>
    Effect.gen(function* () {
      const entry = (
        index: number,
        key: string,
        cost: number,
      ): WorkflowJournalEntry => ({
        index,
        key,
        result: {
          outcome: 'completed',
          usage: { totalCost: cost },
          output: {
            category: 'workflow',
            outputs: [],
            compileFailures: [],
            diffs: [],
          },
        },
      });
      const historical = entry(0, 'historical', 0.8);
      const completed = entry(1, 'completed', 0.5);
      const recovered = entry(2, 'recovered', 0.5);
      const tracker = createWorkflowAttemptCostTracker();
      const recordCost = vi.fn();
      const strategy = createTerminalStrategy(
        'Workflow attempt cost',
        (ports) =>
          Effect.sync((): FakeTurn => {
            ports.recordCost(tracker.record(completed, 0.1));
            ports.recordCost(tracker.record(completed, 0));
            ports.recordCost(tracker.record({ index: 3, key: 'skipped' }, 0.2));
            ports.recordCost(tracker.record({ index: 4, key: 'failed' }, 0.15));
            ports.recordCost(tracker.total([historical, completed, recovered]));
            return { kind: 'terminal', value: 'done' };
          }),
        () => Effect.succeed('delivered'),
      );

      const loop = yield* startLoop(loopRunId(), strategy, {
        recordCost,
      });

      expect(yield* Fiber.join(loop)).toBeUndefined();
      expect(recordCost).toHaveBeenCalledOnce();
      expect(recordCost.mock.calls[0]?.[0]).toBeCloseTo(0.95);
    }),
  );

  it.effect('finalizes and wakes when the parent cost observer throws', () =>
    Effect.gen(function* () {
      const strategy = createTerminalStrategy(
        'throwing cost observer',
        (ports) =>
          Effect.sync((): FakeTurn => {
            ports.recordCost(0.4);
            return { kind: 'terminal', value: 'done' };
          }),
        () => Effect.succeed('delivered'),
      );
      const recordCost = vi.fn(() => {
        throw new Error('observer failed');
      });

      const loop = yield* startLoop(loopRunId(), strategy, { recordCost });

      // The cost observer is forked with `startImmediately` inside the
      // terminal block, so its thunk has already run when the loop exits.
      expect(yield* Fiber.join(loop)).toBeUndefined();
      expect(recordCost).toHaveBeenCalledOnce();
      expect(mocks.submitFollowUp).toHaveBeenCalledOnce();
    }),
  );
});
