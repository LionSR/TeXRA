import { randomUUID } from 'node:crypto';
import { Cause, Clock, Effect, Exit, type Fiber } from 'effect';

// Shared child accounting and durable delivery for native runs and processes.

import type { AgentTrace, StageHandle } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { resolveChildRunConcurrencyBudget } from '@agent/runtime/childRunBudget';
import {
  Runs,
  type AgentRunServices,
  type RunRegistry,
} from '@agent/runtime/runRegistry';
import { endRunOutsideLifecycle } from '@agent/runtime/runLaunchGuard';
import type { RunInput } from '@agent/followUp/RunInput';
import {
  relayDelivery,
  settledRow,
  settlementOf,
  type ChildSettlement,
  type SettlementRow,
} from '@agent/runtime/childSettlement';
import type { AttemptKey } from '@agent/storage/runRecords';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { withLogChannel } from '@logger/effectLog';
import {
  RUN_OUTCOME,
  aggregateId,
  type FollowUpContent,
  type DeliveredResult,
  type RunId,
  type RunOutcome,
  type SubagentProgressUpdate,
  type TokenUsageStats,
} from '@shared/schemas';
import {
  DatabaseNotOwner,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import type { QueuedFollowUp } from '@shared/session/runRows';
import { formatSubagentProgress } from '@shared/subagentFollowup';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import { aggregateError, onAbort } from '@utils/core';
import { formatDuration } from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Capabilities the loop provides to a strategy for the duration of one child
 * run. `notify` is best-effort live progress (no persistence, no gating; one
 * delivery site per turn, so there is nothing to dedupe).
 *
 * A child reports no spend here: each of its priced model calls is one row
 * on its own run, and a parent's or a session's total is the sum over the
 * run tree (`RunView.usage` per run), never a figure a child hands up.
 */
export interface ChildRunPorts {
  notify(update: SubagentProgressUpdate): void;
}

/** A stopped child's pause: the notice its parent reads, and the id a
 *  tool call names to continue it (a Codex thread, a Claude session), which
 *  the `child.park` row keeps so that call reactivates this same run. */
export interface ChildRunPause {
  readonly text: string;
  readonly resumeId?: string;
}

/**
 * Presentation and finalization for process-backed children (agent CLIs,
 * background bash). Native engines own their run handle
 * and terminal finalization and omit this port.
 */
export interface ChildRunPort {
  readonly logger: AgentTrace;
  /** Show the handle to stops, once the loop has reserved their target. */
  track(): void;
  /**
   * Complete the child stream lifecycle through the owning run handle.
   * Resolves once the shared terminal finalizer has persisted, settled, and
   * untracked.
   */
  finalize(options: {
    /** The last turn's settlement, committed with the child's `run.end`. */
    settlement?: readonly SettlementRow[];
    /** The child's report of its own exit, not a verdict: a stop that
     *  already landed CANCELLED outranks a FAILED this reports. */
    outcome: RunOutcome;
    /** Cause behind a FAILED outcome, for diagnosis. */
    error?: unknown;
    /** A stop the loop observed by finalize time: it outranks `outcome`. */
    stopped?: boolean;
    /** Session stage closed with the derived outcome (the loop's stage). */
    stage?: Pick<StageHandle, 'end'>;
    /** The strategy's {@link ChildRunStrategy.pauseNotice}, read on a stop. */
    pauseNotice?: () => ChildRunPause | undefined;
  }): Effect.Effect<void, Error, Runs>;
}

/**
 * A native run's child policy: each turn runs under `turnPermit` (so a WAITING
 * child holds no slot), and each turn settles in the batch that ends it: a
 * boundary's rows commit with its `waiting` step, and `settled` runs once
 * they are durable; the last turn's rows commit with the run's `run.end`.
 */
export interface ChildRunTurns<TTurn> extends ChildRunBoundary<TTurn> {
  /** Settle the run's last turn: rows for its `run.end`. A failure here is
   *  the loop's, raised once the run is joined, never the ending's. */
  settleEnd(turn: TTurn): Effect.Effect<readonly SettlementRow[]>;
}

/** What a native run's loop takes of its child policy. */
export interface ChildRunBoundary<TTurn> {
  turnPermit<A, E, R>(
    turn: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R>;
  /** Settle a turn the run goes on from: rows for its boundary batch. */
  settleBoundary(turn: TTurn): Effect.Effect<
    {
      readonly rows: readonly SettlementRow[];
      readonly settled: Effect.Effect<void, Error>;
    },
    Error
  >;
}

export interface ChildRunStrategy<TTurn, R = never> {
  /** A native program owns its input wait and offers each turn boundary. */
  readonly continuous?: true;
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  readonly stageLabel: string;

  /**
   * This child's turns drive a live OS process (a background bash command,
   * an agent-CLI provider): shutdown drain reaches it through
   * `RunHandle.backgroundProcess` (#8155) without disturbing native agent
   * children left running for restart recovery.
   */
  readonly ownsBackgroundProcess?: boolean;

  /** Deliver a settled turn even when the loop was interrupted: only a
   *  killed OS process, whose exit code and output are a complete result. */
  readonly deliverAfterInterrupt?: boolean;

  /** `persistOnly` records the report without routing it to a parent, for
   *  a headless caller that awaits and reads it itself. */
  readonly deliveryMode?: 'persistOnly';

  /** A stop pauses this child rather than cancelling it: what it had done
   *  and how the parent's model continues it; undefined cancels it. */
  pauseNotice?(): ChildRunPause | undefined;

  /**
   * A native child a user stopped, directly or by stopping its parent: the
   * notice its parent reads, saying what it had done and which run to
   * resume. Queued for the parent's next input without waking it. A process
   * child says this through `pauseNotice`.
   */
  stopNotice?(): Effect.Effect<string, Error, R>;

  /**
   * The one id this child's result is admitted under, for a child that
   * delivers once in its life: a resumed child's delivery is then judged a
   * replay of one its earlier owner admitted. Absent: each turn's own.
   */
  readonly deliveryId?: string;

  /**
   * Produce the first turn's outcome. Throws on hard failure. `R` names the
   * process services a turn reads, forwarded to the loop's caller.
   */
  launch(
    ports: ChildRunPorts,
    signal: AbortSignal,
    turns: ChildRunTurns<TTurn>,
  ): Effect.Effect<TTurn, Error, R>;

  /**
   * Produce the next turn's outcome from the queued follow-up batch. Throws
   * on hard failure. Omitted by strategies whose first (and only) turn is
   * always terminal (a background script); the loop never calls `runTurn` in
   * that case. Native children keep their own input wait inside `launch`.
   */
  runTurn?(
    followUps: readonly FollowUpContent[],
    ports: ChildRunPorts,
    signal: AbortSignal,
  ): Effect.Effect<TTurn, Error, R>;

  /** True when `turn` ends this child's run; no further turns follow. */
  isTerminal(turn: TTurn): boolean;

  /** Token usage for the turn summary (null when none). */
  getUsage?(turn: TTurn): TokenUsageStats | null;

  /**
   * Application-level error reported by a turn that did NOT throw (e.g. the SDK
   * returned an error result). Omit for providers that always throw on failure.
   */
  isTurnError?(turn: TTurn): boolean;
  /** An interrupted interactive turn has no new result to settle. */
  isTurnInterrupted?(turn: TTurn): boolean;

  /** The error message to log for a non-throwing failure, if it has one. */
  turnErrorMessage?(turn: TTurn): string | undefined;

  /** After a successful turn: register the session/thread id, etc. */
  onTurnSuccess?(turn: TTurn, session: SessionHandle): void;

  /** Publish token usage to the UI. */
  publishUsage?(turn: TTurn): void;

  /**
   * Format the success delivery XML. A native document-task subagent
   * reads and writes on the way (diff files land in the run directory
   * first), so this is an Effect over the same `R` the turns read; every
   * other strategy formats from what it already holds.
   */
  formatDelivery(
    turn: TTurn,
    wallTimeMs: number,
  ): Effect.Effect<string, Error, R>;

  /** Format the error delivery XML (turn is null when the call threw). */
  formatError(turn: TTurn | null, err: unknown): string;

  /**
   * Structured result manifest persisted beside each turn's report, success
   * or failure (`turn` null when the call threw), so a failure overwrites a
   * stale interim manifest. Agent-CLI strategies omit it.
   */
  buildResultMeta?(
    turn: TTurn | null,
    isError: boolean,
    wallTimeMs: number,
    /**
     * The thrown error of a failed turn, when the failure was a throw rather
     * than a returned failed result; so the manifest can carry the failure
     * message even when no flow result exists to carry it.
     */
    error?: unknown,
  ): Effect.Effect<DeliveredResult | undefined, Error, R>;

  /**
   * Release provider-owned registry entries. The loop calls this exactly once,
   * before failed/interrupted parent delivery or during finalization.
   */
  releaseSessionOwnership?(): void;
}

export interface ChildRunLoopParams<TTurn, R = never> {
  readonly session: SessionHandle;
  /**
   * Presentation and finalization port for process-backed children (agent
   * CLIs, background bash). Native engines finalize their
   * own run handle.
   */
  readonly childRun?: ChildRunPort;
  readonly parentRunId: RunId;
  /** The child's run id: what the loop reads its input and attaches its
   *  interrupt handler under. */
  readonly runId: RunId;
  readonly agentName: string;
  readonly strategy: ChildRunStrategy<TTurn, R>;
  /**
   * Gate every turn through the session's child-run budget semaphore
   * (`RunRegistry.childRunBudget`); agent-CLI children, external processes,
   * sit outside it (`.agents/docs/implemented/architecture/2026-08-15-child-run-concurrency-budget.md`).
   */
  readonly budgeted: boolean;
  /**
   * Progress sink override for awaiting callers of a persist-only child: the
   * parent is blocked inside a tool call, so follow-up delivery cannot reach
   * it and the caller degrades deliberately (e.g. to the parent run's trace).
   * When present it replaces follow-up delivery for every progress update.
   */
  readonly notify?: (update: SubagentProgressUpdate) => void;
  /**
   * Hands an awaiting caller each settled turn's facts in memory, once per
   * settled turn after persistence; a required-durability caller verifies
   * the store afterwards rather than changing what the loop persists.
   */
  readonly onTurnSettled?: (settled: {
    readonly message: string;
    readonly resultMeta?: DeliveredResult;
    readonly isError: boolean;
    readonly error?: unknown;
  }) => void;
}

/**
 * The child loop's stop, on the run's run registry activation for the loop's whole
 * life, so a stop finds a target in the inter-turn gap too. A process child's
 * turns are reached through `signal` alone (`execa`'s `cancelSignal`, the
 * Codex and Claude Agent SDKs) and its loop fiber survives the abort to
 * deliver and finalize (rulings ledger 2026-08-01). A native child's turn is
 * this session's own run program, so its stop also interrupts the run fiber.
 */
class ChildRunInterruptible {
  private readonly controller = new AbortController();

  constructor(
    private readonly runs: RunRegistry,
    private readonly runId: RunId,
    /** A native child's turns run on the run's fiber; a process child's loop
     *  fiber must survive the stop to deliver and finalize. */
    private readonly interruptsRunFiber: boolean,
  ) {}

  /** The stop was a user's, read when it lands: the registry forgets the
   *  reason once the run has unwound. */
  private stoppedByUser = false;

  interrupt(): void {
    this.stoppedByUser ||= this.runs.stopReason(this.runId) === 'user';
    this.controller.abort();
    if (this.interruptsRunFiber) this.runs.interrupt(this.runId);
  }

  get userStopped(): boolean {
    return this.stoppedByUser;
  }

  isInterrupted(): boolean {
    return this.controller.signal.aborted;
  }

  /** The one cancellation signal every turn of this child runs under: no
   *  turn starts after an interrupt, so a per-turn one would mirror it. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }
}

const CHANNEL = 'childRunLoop';
const SLOT_CANCELLED =
  'Child run turn cancelled while awaiting a concurrency slot.';

const EFFECT_LOG = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
} as const;

/**
 * Write one loop diagnostic. An agent-CLI child presents them on its own
 * trace; every other child has no loop-owned stream, so they go to the
 * process log under this module's channel.
 */
function loopLog(
  trace: AgentTrace | undefined,
  level: keyof typeof EFFECT_LOG,
  message: string,
  data?: unknown,
): Effect.Effect<void> {
  if (trace) {
    return Effect.sync(() =>
      trace[level](message, data === undefined ? undefined : { data }),
    );
  }
  const entry = EFFECT_LOG[level](message).pipe(withLogChannel(CHANNEL));
  return data === undefined ? entry : Effect.annotateLogs(entry, { data });
}

/** Outcome of a single turn attempt, flattening the loop's inner try/catch. */
type TurnAttempt<TTurn> =
  | { kind: 'completed'; turn: TTurn; turnIsError: boolean }
  | { kind: 'failed'; err: unknown }
  | { kind: 'interrupted' };

/**
 * Run one turn (via `runner`) and classify the outcome. A clean interruption
 * maps to `interrupted` (the caller breaks), a thrown call to `failed`, and a
 * returned turn to `completed` (carrying its application-level error flag).
 * A native run's exit is classified the same way: joined, its failure is the
 * failed turn a thrown call is.
 */
function attemptTurn<TTurn, R, RTurn>(
  strategy: ChildRunStrategy<TTurn, R>,
  runner: (signal: AbortSignal) => Effect.Effect<TTurn, Error, RTurn>,
  loop: ChildRunInterruptible,
  trace: AgentTrace | undefined,
  startedAt: number,
): Effect.Effect<TurnAttempt<TTurn>, never, RTurn> {
  return Effect.gen(function* () {
    const attempt = yield* Effect.exit(
      Effect.gen(function* () {
        const turn = yield* runner(loop.signal);
        // The turn summary (duration + token usage) on the child stream.
        const wallTimeMs = (yield* Clock.currentTimeMillis) - startedAt;
        yield* loopLog(
          trace,
          'info',
          `Turn completed in ${formatDuration(wallTimeMs)}`,
        );
        const usage = strategy.getUsage?.(turn);
        if (usage) {
          yield* loopLog(trace, 'info', 'Tokens', {
            input: usage.inputTokens,
            output: usage.outputTokens,
          });
        }
        const turnIsError = strategy.isTurnError?.(turn) === true;
        const turnError = turnIsError
          ? strategy.turnErrorMessage?.(turn)
          : undefined;
        if (turnError) yield* loopLog(trace, 'error', turnError);
        return { kind: 'completed' as const, turn, turnIsError };
      }),
    );
    if (Exit.isSuccess(attempt)) return attempt.value;
    const caught = Cause.squash(attempt.cause);
    if (loop.isInterrupted() || isUserAbort(caught)) {
      return { kind: 'interrupted' as const };
    }
    yield* loopLog(trace, 'error', toErrorMessage(caught));
    return { kind: 'failed' as const, err: caught };
  });
}

/**
 * The delivery id one accepted turn's single parent delivery is admitted
 * under (#9531). A turn that ran queued follow-ups takes its identity from
 * the prompt's durable rows, so a crash between parent admission and prompt
 * consumption re-executes under a new attempt id yet is judged a replay.
 * Every other turn takes the `child.turn` row's key (run, attempt, turn
 * index), distinct across attempts even when a workflow reuses its run id.
 */
function turnDeliveryId(
  runId: RunId,
  turn: AttemptKey,
  consumed: readonly QueuedFollowUp[],
): string {
  const prompt = consumed[0]?.followUpId;
  if (prompt !== undefined) return `${runId}:${prompt}:delivery`;
  return `${runId}:${turn.key}:${turn.index}:delivery`;
}

type ChildLoopTerminationCause = 'interrupted' | 'turn_failed' | 'terminal';

/**
 * Commit one turn's `child.turn accepted` row (#9531), the fact the
 * report/result slots are attributed from. Not best-effort: a refused append
 * is the turn's failure, and `not-owner` stops the loop rather than run under
 * a lost claim (R7).
 */
function commitChildTurn(
  session: SessionHandle,
  runId: RunId,
  turn: AttemptKey,
  phase: 'accepted',
): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> {
  return session
    .commit([
      {
        type: 'child.turn',
        aggregateId: aggregateId('run', runId),
        attemptId: turn.key,
        turnIndex: turn.index,
        phase,
      },
    ])
    .pipe(Effect.asVoid);
}

/**
 * Commit a process child's interim settlement in one batch. When that batch
 * is refused the turn still settles, with no report and nothing consumed, so
 * a recovering caller's re-execution gate reads it and the prompt stays
 * queued; the refusal is then the turn's failure.
 */
const commitSettlement = (
  session: SessionHandle,
  runId: RunId,
  { rows }: ChildSettlement,
): Effect.Effect<void, Error> =>
  session.commit(rows).pipe(
    Effect.asVoid,
    Effect.catch((error) => {
      const settled = rows.findLast((row) => row.type === 'child.turn');
      return (
        settled === undefined
          ? Effect.void
          : session.commit([
              settledRow(runId, {
                key: settled.attemptId,
                index: settled.turnIndex,
              }),
            ])
      ).pipe(Effect.andThen(Effect.fail(error)));
    }),
  );

/**
 * Move an agent-CLI child's phase across its park (one run model, 3.3):
 * `parked` before the loop blocks on its queue, `resumed` when the taken
 * batch starts the next turn. Without it the idle run stays RUNNING and the
 * next submission classifies as `no_session`; native children park through
 * their own loop's `waiting` step, so each park keeps one writer.
 */
function commitPark(
  session: SessionHandle,
  runId: RunId,
  phase: 'parked' | 'resumed',
): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> {
  return session
    .commit([
      { type: 'child.park', aggregateId: aggregateId('run', runId), phase },
    ])
    .pipe(Effect.asVoid);
}

/** The child loop's abort as an Effect: settles with `outcome()`, built
 *  only when `signal` aborts, and never otherwise. */
function onceAborted<A, E>(
  signal: AbortSignal,
  outcome: () => Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.callback<A, E>((resume) => {
    const detach = onAbort(signal, () => resume(outcome()));
    return Effect.sync(detach);
  });
}

/**
 * Own one child's delivery, queue, concurrency budget and terminal cleanup.
 * A native launch runs on its own fiber and offers its turn boundaries to
 * this loop; process strategies return a turn and wait for their next batch
 * here.
 */
export function startChildRunLoop<TTurn, R extends AgentRunServices = never>(
  params: ChildRunLoopParams<TTurn, R>,
): Effect.Effect<Fiber.Fiber<TTurn | undefined, Error>, Error, R | Runs> {
  const runSession = params.session;
  const runId = params.runId;
  // The launch's unwind bookkeeping lives beside the generator, not inside
  // it: the `onExit` chained after it runs the same compensation when the
  // launch unwinds before the fork, so these stay in its scope.
  let sessionStage: StageHandle | undefined;
  let releaseChildActivation: () => void = () => undefined;
  let releaseSessionOwnershipOnce: () => void = () => undefined;
  // Set once the setup's compensation has run (either early-fail path or
  // the launch's exit finalizer), so it never runs twice.
  let setupUnwound = false;
  // Set once the fork has handed settlement to the daemon; an unwind of the
  // launch fiber before that point still owns the setup it acquired.
  let forked = false;
  // Unwind setup and lane refusals before the run body takes ownership.
  const unwindSetup = (error: unknown): Effect.Effect<Error> =>
    Effect.suspend(() => {
      setupUnwound = true;
      return Effect.gen(function* () {
        const cleanupErrors: unknown[] = [];
        const cleanups = [
          () => sessionStage?.end(RUN_OUTCOME.FAILED),
          releaseChildActivation,
          releaseSessionOwnershipOnce,
        ];
        for (const cleanup of cleanups) {
          const result = yield* Effect.exit(Effect.sync(cleanup));
          if (Exit.isFailure(result))
            cleanupErrors.push(Cause.squash(result.cause));
        }
        return ensureError(
          aggregateError(
            [error, ...cleanupErrors],
            `Child run ${runId} setup failed and rollback was incomplete`,
          ),
        );
      });
    });

  return Effect.gen(function* () {
    const runs = yield* Runs;
    const { childRun, parentRunId, agentName, strategy } = params;
    // An agent-CLI child presents on its own trace; `loopLog` sends every
    // other child's driver diagnostics to the process log.
    const trace = childRun?.logger;
    const loop = new ChildRunInterruptible(runs, runId, childRun === undefined);
    // Every child loop reserves its stop target on the run's run registry entry for
    // its whole life; only a native one retains a terminal parent's
    // continuation. The parent edge is the run registry's shared cell.
    const parent = runs.getHandle(runId)?.parentState ?? {
      current: parentRunId,
    };
    releaseChildActivation = runs.reserveChildActivation({
      runId,
      parent,
      retainsTerminalParent: childRun === undefined,
      interrupt: () => loop.interrupt(),
    });
    // Read after the reservation, so no stop lands while there is no target.
    const budget = params.budgeted
      ? yield* runs.childRunBudget(
          yield* resolveChildRunConcurrencyBudget(runSession.roots),
        )
      : undefined;
    let sessionOwnershipReleased = false;
    releaseSessionOwnershipOnce = (): void => {
      if (sessionOwnershipReleased) return;
      sessionOwnershipReleased = true;
      strategy.releaseSessionOwnership?.();
    };

    // A process child's driver reads its input; a native child's own
    // loop does (it opens its reader as any run's loop does).
    let input!: RunInput;

    const setup = yield* Effect.exit(
      Effect.sync(() => {
        // A stop sees the handle only from here, with its target reserved.
        childRun?.track();
        if (strategy.ownsBackgroundProcess === true) {
          // The one handle slot shutdown drain reads (#8155): kill the
          // leaked OS process without touching the loop that reports it.
          const handle = runs.getHandle(runId);
          if (handle) {
            handle.backgroundProcess = { kill: () => loop.interrupt() };
          }
        }
        sessionStage = trace?.openStage(strategy.stageLabel);
      }),
    );
    if (Exit.isFailure(setup)) {
      return yield* Effect.fail(yield* unwindSetup(Cause.squash(setup.cause)));
    }

    const attemptId = randomUUID();
    // Progress reaches the parent as queued follow-ups. The port is
    // synchronous, so each is enqueued on the session's publisher where it is
    // reported and commits ahead of the result row `deliverTurn` enqueues later.
    const ports: ChildRunPorts = {
      notify: (update) => {
        if (params.notify) {
          params.notify(update);
          return;
        }
        if (strategy.deliveryMode === 'persistOnly' || parent.current === null)
          return;
        const targetRunId = parent.current ?? undefined;
        if (!targetRunId) return;
        // Nothing is queued when no session holds the run.
        if (
          runSession.runs.getToolUseFollowUpTarget(targetRunId).kind !==
          'no_session'
        ) {
          runSession.followUps.sendDetached(targetRunId, {
            text: formatSubagentProgress(runId, agentName, update),
            from: { kind: 'run', runId },
          });
        }
      },
    };

    let sawTurnFailure = false;
    let lastTurnErr: unknown;
    // The last turn's settlement: committed with the child's `run.end`
    // (by its lifecycle, `ended`, or by the finalize below), and relayed
    // only after the child's finalization and claim release.
    let ending: ChildSettlement | undefined;
    let ended = false;
    let endReport: Effect.Effect<void> = Effect.void;
    // Hold the slot only while a turn runs, unmasked. A stop races the slot
    // wait alone; an admitted turn observes the loop's signal itself.
    const gateTurn = (
      base: (signal: AbortSignal) => Effect.Effect<TTurn, Error, R>,
    ): ((signal: AbortSignal) => Effect.Effect<TTurn, Error, R>) =>
      budget === undefined
        ? base
        : (signal) => {
            let admitted = false;
            return Effect.raceFirst(
              budget.withPermit(
                Effect.suspend(() => ((admitted = true), base(signal))),
              ),
              onceAborted(signal, () =>
                admitted
                  ? Effect.never
                  : Effect.fail(new Error(SLOT_CANCELLED)),
              ),
            );
          };

    let runStarted = false;
    // The loop's hold on the child's claim for the child's whole life: its
    // birth claim, or — for a recovered child — the claim taken over after
    // its prior owner is proved dead. Released once the child's ending has
    // committed and before its final delivery, which the parent may answer
    // at once by reading the child.
    let releaseClaim: Effect.Effect<void> = Effect.void;
    const run = Effect.gen(function* () {
      runStarted = true;
      releaseClaim = yield* runSession.acquireClaims(
        aggregateId('run', runId),
        {
          ends: true,
        },
      );
      let turnIndex = 0;
      let result: TTurn | undefined;
      yield* Effect.scoped(
        Effect.gen(function* () {
          if (!strategy.continuous) {
            const reader = yield* runSession.followUps.open(runId);
            input = reader;
            // Its end is the child's: it takes no more input here.
            yield* Effect.addFinalizer(() =>
              Effect.sync(() =>
                runSession.followUps.release(runId, reader, true),
              ),
            );
          }
          let consumed: readonly QueuedFollowUp[] = [];
          let turnStart = yield* Clock.currentTimeMillis;
          const beginTurn = Effect.gen(function* () {
            turnIndex += 1;
            turnStart = yield* Clock.currentTimeMillis;
            const turnKey = { key: attemptId, index: turnIndex };
            yield* commitChildTurn(runSession, runId, turnKey, 'accepted');
          });
          // One turn's settlement and the report an awaiting caller reads.
          const settle = (
            turn: TTurn | null,
            err: unknown,
            turnIsError: boolean,
          ) =>
            Effect.gen(function* () {
              if (turnIndex === 0) yield* beginTurn;
              const turnKey = { key: attemptId, index: turnIndex };
              const wallTimeMs = (yield* Clock.currentTimeMillis) - turnStart;
              const isError = err != null || turnIsError;
              if (turn != null) strategy.publishUsage?.(turn);
              const message =
                turn != null && !isError
                  ? yield* strategy.formatDelivery(turn, wallTimeMs)
                  : yield* Effect.try({
                      try: () => strategy.formatError(turn, err),
                      catch: ensureError,
                    });
              const resultMeta = strategy.buildResultMeta
                ? yield* strategy.buildResultMeta(
                    turn,
                    isError,
                    wallTimeMs,
                    err ?? undefined,
                  )
                : undefined;
              const settlement = settlementOf({
                runId,
                turn: turnKey,
                message,
                resultMeta,
                consumed,
                deliveryId:
                  strategy.deliveryId ??
                  turnDeliveryId(runId, turnKey, consumed),
                to: yield* deliveryTarget(turn, isError),
              });
              // The settled facts reach the caller once the rows commit,
              // or once the commit failed (then the turn's failure).
              const report = Effect.sync(() =>
                params.onTurnSettled?.({
                  message,
                  ...(resultMeta !== undefined && { resultMeta }),
                  isError,
                  ...(err != null && { error: err }),
                }),
              );
              return { settlement, report };
            });
          /** Who reads this turn's result: its parent, unless the child is
           *  persist-only, detached, or stopped with nothing to deliver. */
          const deliveryTarget = (turn: TTurn | null, isError: boolean) =>
            Effect.gen(function* () {
              if (strategy.deliveryMode === 'persistOnly') return null;
              const target = parent.current ?? null;
              if (target === null) {
                yield* loopLog(
                  trace,
                  'warn',
                  'Turn result not delivered: child was detached from its orchestrator. The result remains in the run report.',
                  { runId },
                );
                return null;
              }
              if (loop.isInterrupted()) {
                releaseSessionOwnershipOnce();
                return strategy.deliverAfterInterrupt === true ? target : null;
              }
              if (isError) releaseSessionOwnershipOnce();
              else if (turn != null) strategy.onTurnSuccess?.(turn, runSession);
              return target;
            });
          let endFailure: Error | undefined;
          const settleEnd = (
            turn: TTurn | null,
            err: unknown,
            isError: boolean,
          ) =>
            settle(turn, err, isError).pipe(
              Effect.map(({ settlement, report }) => {
                ending = settlement;
                endReport = report;
                return settlement.rows;
              }),
              Effect.catch((error) =>
                Effect.sync(() => {
                  endFailure = error;
                  return [];
                }),
              ),
            );
          // The native run settles on its own fiber, under these services.
          const services = yield* Effect.context<R>();
          const turns: ChildRunTurns<TTurn> = {
            turnPermit: (turn) =>
              Effect.gen(function* () {
                if (loop.isInterrupted()) return yield* Effect.interrupt;
                yield* beginTurn;
                return yield* budget ? budget.withPermit(turn) : turn;
              }),
            settleBoundary: (turn) =>
              Effect.map(
                settle(turn, null, false),
                ({ settlement, report }) => ({
                  rows: settlement.rows,
                  settled: report.pipe(
                    Effect.andThen(
                      settlement.delivery === undefined
                        ? Effect.void
                        : relayDelivery(runSession, settlement.delivery, trace),
                    ),
                  ),
                }),
              ).pipe(Effect.provide(services)),
            // The native run's own `run.end` commits these rows.
            settleEnd: (turn) =>
              strategy.isTurnInterrupted?.(turn) === true
                ? Effect.succeed([])
                : settleEnd(
                    turn,
                    null,
                    strategy.isTurnError?.(turn) === true,
                  ).pipe(
                    Effect.tap(() => Effect.sync(() => (ended = true))),
                    Effect.provide(services),
                  ),
          };
          let runner: (
            signal: AbortSignal,
          ) => Effect.Effect<TTurn, Error, R> = (signal) =>
            strategy.launch(ports, signal, turns);
          while (!loop.isInterrupted()) {
            if (!strategy.continuous) yield* beginTurn;
            const attempt = yield* attemptTurn(
              strategy,
              // A native run takes its permit per turn (`turnPermit`).
              strategy.continuous ? runner : gateTurn(runner),
              loop,
              trace,
              turnStart,
            );
            if (attempt.kind === 'interrupted') break;
            const turn = attempt.kind === 'completed' ? attempt.turn : null;
            if (turn !== null) result = turn;
            if (turn !== null && strategy.isTurnInterrupted?.(turn)) {
              loop.interrupt();
              break;
            }
            const err = attempt.kind === 'failed' ? attempt.err : null;
            const turnIsError =
              attempt.kind === 'completed' && attempt.turnIsError;
            const turnFailed = err != null || turnIsError;
            const last =
              turnFailed ||
              turn == null ||
              strategy.isTerminal(turn) ||
              !strategy.runTurn;
            // A launch failure can terminate before its first model cycle.
            if (
              turnIndex === 0 &&
              err != null &&
              !(yield* runSession.ownsRun(runId))
            )
              return yield* Effect.fail(ensureError(err));
            if (turnFailed) {
              sawTurnFailure = true;
              lastTurnErr =
                err ??
                new Error(
                  `${strategy.stageLabel} reported a failed turn without throwing.`,
                );
            }
            if (last) {
              // A native run's own `run.end` already carried it.
              if (ending === undefined && endFailure === undefined)
                yield* settleEnd(turn, err, turnIsError);
              if (endFailure !== undefined)
                return yield* Effect.fail(endFailure);
              break;
            }
            // A process child's interim turn: its rows, then its relay,
            // before it waits for its next input.
            const { settlement, report } = yield* settle(
              turn,
              err,
              turnIsError,
            );
            yield* commitSettlement(runSession, runId, settlement);
            yield* report;
            if (settlement.delivery !== undefined)
              yield* relayDelivery(runSession, settlement.delivery, trace);
            if (loop.isInterrupted()) break;

            // The park is durable before the block, so a follow-up arriving
            // while this loop sleeps is admitted onto its queue instead of
            // being refused against a run that only looks busy.
            yield* commitPark(runSession, runId, 'parked');
            const nextRunTurn = strategy.runTurn;
            if (nextRunTurn === undefined) break;
            // The queue wait, raced against the loop's stop; null when stopped.
            const batch = yield* Effect.raceFirst(
              input.take,
              onceAborted(loop.signal, () => Effect.succeed(null)),
            ).pipe(Effect.interruptible);
            if (!batch || loop.isInterrupted()) break;
            // The batch leaves the park: the loop is running again from
            // here, and the turn it is about to accept is the top's.
            // A view edit is asked of a root's own loop, never of a child.
            if (batch.kind === 'edit')
              return yield* Effect.die(
                new Error(`${runId}: a child run took a view edit`),
              );
            const taken = batch.kind === 'synthetic' ? [] : batch.followUps;
            yield* commitPark(runSession, runId, 'resumed');
            consumed = taken;
            const prompts: readonly FollowUpContent[] =
              batch.kind === 'synthetic'
                ? [{ text: batch.text, from: { kind: 'user' } }]
                : taken.map((followUp) => followUp.content);
            runner = (signal) => nextRunTurn(prompts, ports, signal);
          }
        }),
      );
      return result;
    }).pipe(
      // The loop's terminal, in the toolUse exit-protocol pattern: a stop
      // lands before it or after it, never inside, so the queue lease, the
      // terminal row, the claim release and the final delivery settle
      // atomically on every exit.
      Effect.onExit((body) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const stopped =
              loop.isInterrupted() ||
              (Exit.isFailure(body) && Cause.hasInterrupts(body.cause));
            if (Exit.isFailure(body) && !Cause.hasInterruptsOnly(body.cause)) {
              const error = Cause.squash(body.cause);
              sawTurnFailure = true;
              lastTurnErr ??= error;
              // A lost aggregate claim: this process no longer owns the run,
              // so the loop stops rather than continue under it.
              if (error instanceof DatabaseNotOwner) loop.interrupt();
            }

            // The last turn's facts reach an awaiting caller before the
            // child ends, as every earlier turn's did.
            yield* endReport;
            const terminal = yield* Effect.exit(
              Effect.gen(function* () {
                let terminationCause: ChildLoopTerminationCause = 'terminal';
                if (stopped) terminationCause = 'interrupted';
                else if (sawTurnFailure) terminationCause = 'turn_failed';
                // Debug-only driver diagnostic (#9531): how the loop ended.
                yield* loopLog(trace, 'debug', 'childRunLoop loop.terminated', {
                  runId,
                  interruptionCause: terminationCause,
                });
                // Re-read: a stop landing after the body's exit is still the
                // run's terminal verdict.
                const stoppedAtExit = stopped || loop.isInterrupted();
                const outcome = deriveRunOutcome({
                  failed: sawTurnFailure,
                  cancelled: stoppedAtExit,
                });
                const settlement = ended ? [] : (ending?.rows ?? []);
                if (childRun) {
                  yield* childRun.finalize({
                    settlement,
                    outcome,
                    error: lastTurnErr,
                    stopped: stoppedAtExit,
                    stage: sessionStage,
                    // A persist-only child routes nothing to a parent,
                    // so nobody could continue it: its stop cancels it.
                    ...(strategy.deliveryMode !== 'persistOnly' && {
                      pauseNotice: strategy.pauseNotice,
                    }),
                  });
                } else {
                  // A native run's lifecycle is its one terminal writer, and
                  // its fiber has exited by now. A failure or stop can precede
                  // that lifecycle (an end it wrote stands). A launch that
                  // returned its last turn with no lifecycle to settle it (a
                  // strategy that writes no `run.end`) settles it alone.
                  const abnormal = stoppedAtExit || sawTurnFailure;
                  if (abnormal && (yield* runSession.ownsRun(runId)))
                    yield* endRunOutsideLifecycle(
                      runSession,
                      runId,
                      outcome,
                      lastTurnErr,
                      settlement,
                    );
                  else if (!abnormal && settlement.length > 0)
                    yield* runSession.commit(settlement);
                  // A user's stop, not a shutdown: what the child left for
                  // its parent to resume, read with the parent's next input.
                  const target = parent.current;
                  if (
                    strategy.stopNotice !== undefined &&
                    strategy.deliveryMode !== 'persistOnly' &&
                    loop.userStopped &&
                    target !== null
                  ) {
                    // A notice that cannot be read still says the child
                    // stopped: the stop stands, and the failure is loud.
                    const text = yield* strategy.stopNotice().pipe(
                      Effect.catch((error) =>
                        loopLog(trace, 'warn', 'Child-run stop notice failed', {
                          runId,
                          error,
                        }).pipe(
                          Effect.as(
                            `Run ${runId} was stopped. What it had done could not be read: ${toErrorMessage(error)}`,
                          ),
                        ),
                      ),
                    );
                    yield* runSession.followUps.send(
                      target,
                      {
                        text,
                        from: { kind: 'run', runId },
                        deliveryId: `${runId}:${attemptId}:stopped`,
                      },
                      { hold: 'instruction' },
                    );
                  }
                }
              }),
            );
            // Provider ids stay reserved until the terminal (or pause) row
            // is written, so a call naming one finds this run, not a gap.
            const owned = yield* Effect.exit(
              Effect.sync(releaseSessionOwnershipOnce),
            );
            // The parent may immediately read this child; release its claim first.
            yield* releaseClaim;
            const delivery = yield* Effect.exit(
              ending?.delivery === undefined
                ? Effect.void
                : relayDelivery(runSession, ending.delivery, trace),
            );
            const activation = yield* Effect.exit(
              Effect.sync(releaseChildActivation),
            );
            const failures = [terminal, owned, delivery, activation].flatMap(
              (exit) =>
                Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
            );
            // The body's own failure or interruption propagates past this
            // finalizer as itself; only the cleanup's failures join it.
            if (failures.length > 0) {
              return yield* Effect.fail(
                ensureError(
                  aggregateError(failures, 'Child run and cleanup failed'),
                ),
              );
            }
          }),
        ),
      ),
    );
    // The launched fiber owns settlement from its first step; an unwind of
    // the launch before that still owns the setup it acquired. It is
    // admitted a tick later, once this launch has handed back its fiber.
    return yield* runs.launch(runId, run, (admitted) =>
      Effect.suspend(() => {
        forked = true;
        return Effect.andThen(Effect.yieldNow, admitted).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.gen(function* () {
                  const error = runStarted
                    ? ensureError(Cause.squash(cause))
                    : yield* unwindSetup(Cause.squash(cause));
                  return yield* Effect.fail(error);
                }),
          ),
        );
      }),
    );
  }).pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit) || forked || setupUnwound) return Effect.void;
      // The handoff never happened: the setup this launch acquired unwinds
      // here, atomically, rather than leaking the queue lease, the
      // activation and the stage.
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const error = yield* unwindSetup(Cause.squash(exit.cause));
          return yield* Effect.fail(error);
        }),
      );
    }),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(ensureError(Cause.squash(cause))),
    ),
  );
}
