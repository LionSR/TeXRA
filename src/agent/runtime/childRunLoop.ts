import { randomUUID } from 'node:crypto';
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Result } from 'effect';

// Shared child accounting and durable delivery for native runs and processes.

import { finalizeRun } from '@agent/storage';
import type { AgentTrace, StageHandle } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { finalizeRunTerminal } from '@agent/runtime/AgentRunLifecycle';
import { resolveChildRunConcurrencyBudget } from '@agent/runtime/childRunBudget';
import type {
  RunHandle,
  RunInterruptHandler,
  RunParent,
} from '@agent/runtime/RunHandle';
import { Runs } from '@agent/runtime/runRegistry';
import { RunInput, type QueuedFollowUp } from '@agent/followUp/RunInput';
import type {
  FollowUpConsumerLease,
  FollowUpQueueInput,
  FollowUpRecoveryLease,
} from '@agent/followUp/ToolUseFollowUpQueueManager';
import {
  startFollowUpWake,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { persistChildRunDelivery } from '@agent/storage/childRunDeliveryPersistence';
import { classifyAgentError } from '@common/errors';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { withLogChannel } from '@logger/effectLog';
import { AgentResume } from '@platform/interfaces';
import {
  RUN_OUTCOME,
  aggregateId,
  type FollowUpContent,
  type ResultMeta,
  type RunId,
  type RunOutcome,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import type { AttemptKey } from '@shared/session/attemptFold';
import {
  DatabaseNotOwner,
  type DatabaseWriteFailed,
} from '@shared/session/database';
import { foldRunState } from '@shared/session/runStateFold';
import { formatSubagentProgress } from '@shared/subagentFollowup';
import { deriveRunOutcome } from '@shared/runs/runStatus';
import { aggregateError, onAbort } from '@utils/core';
import { formatDuration } from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

/** Minimal token usage shape consumed by the loop's turn summary. */
type TurnUsage = { input_tokens?: number; output_tokens?: number };

/**
 * Capabilities the loop provides to a strategy for the duration of one child
 * run. `notify` is best-effort live progress (no report/manifest persist, no
 * gating; duplicate delivery is impossible by construction since there is
 * one delivery site per turn, so there is nothing left to dedupe against).
 *
 * ## Cost accounting contract (the one discipline every child-run type keeps)
 *
 * One fact; "this child's total spend"; flows through three fixed roles:
 *
 * - **Observe.** A strategy reports spend only through `recordCost`, and only
 *   as a *cumulative total for the physical run so far*, never a delta. Native
 *   subagents pass each turn's run-cumulative `usage.totalCost`
 *   (`nativeSubagentStrategy.runNative`). The workflow-script strategy's
 *   attempt model is per-grandchild deltas, so it converts them into an
 *   invocation-cumulative total first (`createWorkflowAttemptCostTracker`) —
 *   the retention rule below is only correct over cumulative observations.
 *   Replayed/recovered journal work observes zero (it was billed by the run
 *   that produced it), and `invocation.report({ costUsd })` is snapshot
 *   display, never accounting.
 * - **Retain.** The loop retains `max(best defined observation)`. Max over
 *   cumulative totals is order-insensitive and monotone, so a later partial
 *   source cannot replace the best available total; max over deltas would
 *   under-bill, which is why observation is cumulative by contract.
 * - **Commit.** Exactly one commit per physical child run, at run end, into
 *   `params.recordCost`; the parent-side callback *adds* into the parent's
 *   usage totals, so a second commit is double-billing and a missed one is
 *   under-billing. The in-band single-cycle path has exactly one observation
 *   per physical attempt and forwards it to its caller's `onCost` once; there
 *   is no multi-observation in-band path, hence no retention layer there.
 * - **Failure path (workflow).** A failed run settles from the checkpoint
 *   journal; if settlement itself fails, that spend stays unbilled and must be
 *   warned about loudly; never silently, and never masking the run error.
 *   Live observations already retained remain committed.
 * - **Agent-CLI children** wire no cost observer by design: their spend is
 *   external (the user's own claude/codex subscription), not TeXRA-billed
 *   USD. A future cost-reporting CLI must observe through this same
 *   cumulative discipline rather than adding a parallel channel.
 */
export interface ChildRunPorts {
  notify(update: SubagentProgressUpdate): void;
  recordCost(totalCost: number | undefined): void;
}

/**
 * Agent-CLI presentation and finalization. Native engines own their run
 * handle and terminal finalization and omit this port.
 */
interface ChildRunPort {
  readonly logger: AgentTrace;
  /**
   * Complete the child stream lifecycle through the owning run handle.
   * Resolves once the shared terminal finalizer has persisted, settled, and
   * untracked.
   */
  finalize(options: {
    /**
     * The child's report of its own exit. A report, not a verdict: the stream
     * phase owns the terminal outcome, so an explicit stop/kill that already
     * landed CANCELLED outranks a FAILED this reports.
     */
    outcome: RunOutcome;
    /** Cause behind a FAILED outcome, for diagnosis. */
    error?: unknown;
    /** Session stage closed with the derived outcome (the loop's stage). */
    stage?: Pick<StageHandle, 'end'>;
  }): Effect.Effect<void, Error, Runs>;
}

/** A native run keeps its scope while each turn is admitted, budgeted and delivered. */
export interface ChildRunTurns<TTurn, R = never> {
  run<A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Error, R>;
  complete(turn: TTurn): Effect.Effect<void, Error, R | AgentResume>;
}

export interface ChildRunStrategy<TTurn, R = never> {
  /** A native program owns its input wait and calls the supplied turn boundary. */
  readonly continuous?: true;
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  readonly stageLabel: string;

  /**
   * This child's turns drive a live OS process, so the loop's interrupt
   * handler tears one down. Shutdown drain reads it off the handle to reach a
   * leaked process (`RunRegistry.killBackgroundProcesses`) without
   * disturbing agent children that are deliberately left running for restart
   * recovery; see `RunInterruptHandler.ownsBackgroundProcess`.
   */
  readonly ownsBackgroundProcess?: boolean;

  /**
   * Deliver a settled turn to the parent even when the loop was interrupted.
   * Default (and right for every agent child) is not to: an interrupted turn
   * has no result to report. A killed OS process is the exception; it still
   * reports a complete result (exit code plus the output it produced), and a
   * parent suspended on that job would otherwise never be told it ended.
   */
  readonly deliverAfterInterrupt?: boolean;

  /**
   * `persistOnly` records the terminal report without routing it to a parent.
   * Used when a headless caller awaits and reads that report itself. Omitted
   * strategies deliver normally.
   */
  readonly deliveryMode?: 'persistOnly';

  /**
   * Produce the first turn's outcome. Throws on hard failure. `R` names the
   * process services a turn reads (the native strategy's engine turns read
   * `AppState`); the loop forwards it to its caller,
   * where the process runtime provides them.
   */
  launch(
    ports: ChildRunPorts,
    signal: AbortSignal,
    turns: ChildRunTurns<TTurn, R>,
  ): Effect.Effect<TTurn, Error, R>;

  /**
   * Produce the next turn's outcome from the queued follow-up batch. Throws
   * on hard failure. Omitted by strategies whose first (and only) turn is
   * always terminal (workflow-script); the loop never calls `runTurn` in
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
  getUsage?(turn: TTurn): TurnUsage | null;

  /**
   * Application-level error reported by a turn that did NOT throw (e.g. the SDK
   * returned an error result). Omit for providers that always throw on failure.
   */
  isTurnError?(turn: TTurn): boolean;
  /** An interrupted interactive turn has no new result to settle. */
  isTurnInterrupted?(turn: TTurn): boolean;

  /** The error message to log for a non-throwing failure, if it has one. */
  turnErrorMessage?(turn: TTurn): string | undefined;

  /** After loop setup, before the initial turn starts. */
  onLoopStart?(session: SessionHandle): void;

  /** After a successful turn: register the session/thread id, etc. */
  onTurnSuccess?(turn: TTurn, session: SessionHandle): void;

  /** Publish token usage to the UI. */
  publishUsage?(turn: TTurn): void;

  /**
   * Format the success delivery XML. A native workflow-category subagent
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
   * Structured result manifest for a turn's delivery, persisted alongside the
   * report so `/executions/{id}/result` reflects the latest turn; called for
   * both success and failure (`turn` is null when the call threw, `isError`
   * is set for both a throw and a non-throwing application-level failure) so
   * a failure overwrites any earlier interim-success manifest instead of
   * leaving it stale. Native strategies provide one per turn; agent-CLI
   * strategies omit it; they have no chaining-manifest contract.
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
  ): Effect.Effect<ResultMeta | undefined, Error, R>;

  /**
   * Release provider-owned registry entries. The loop calls this exactly once,
   * before failed/interrupted parent delivery or during finalization.
   */
  releaseSessionOwnership?(): void;
}

export interface ChildRunLoopParams<TTurn, R = never> {
  readonly session: SessionHandle;
  /** The recovery boundary already claimed this queue before loading its rows. */
  readonly queueLease?: FollowUpRecoveryLease;
  /**
   * Agent-CLI presentation. Native engines finalize their own run handle.
   */
  readonly childRun?: ChildRunPort;
  readonly parentRunId: RunId;
  /** The child's run id: what the loop acquires the follow-up queue and
   *  attaches its interrupt handler under, before the first turn runs. */
  readonly runId: RunId;
  readonly agentName: string;
  readonly strategy: ChildRunStrategy<TTurn, R>;
  /**
   * Roll this child's final cost into the parent's usage totals. Omitted by
   * agent-CLI callers (no cost concept today); native delegation passes its
   * captured `recordSubagentCost` closure. Synchronous by contract: the loop
   * runs it inside `Effect.try`, which folds a throw and would take a
   * returned promise for the observer's result.
   */
  readonly recordCost?: (totalCost: number | undefined) => void;
  /**
   * Gate every turn through the session's child-run budget semaphore
   * (`RunRegistry.childRunBudget`); agent-CLI children, external processes,
   * sit outside it (`.agents/docs/implemented/architecture/2026-08-15-child-run-concurrency-budget.md`).
   */
  readonly budgeted?: boolean;
  /**
   * Progress sink override for awaiting callers of a persist-only child: the
   * parent is blocked inside a tool call, so follow-up delivery cannot reach
   * it and the caller degrades deliberately (e.g. to the parent run's trace).
   * When present it replaces follow-up delivery for every progress update.
   */
  readonly notify?: (update: SubagentProgressUpdate) => void;
  /**
   * Hands an awaiting caller each settled turn's facts in memory; the
   * formatted message, the (turn-stamped) result manifest, and the raw error
   * of a failed turn. Persistence stays best-effort in the loop; a caller
   * with a required-durability contract verifies the store afterwards rather
   * than changing what the loop persists. Fires after persistence, once per
   * settled turn.
   */
  readonly onTurnSettled?: (settled: {
    readonly message: string;
    readonly resultMeta?: ResultMeta;
    readonly isError: boolean;
    readonly error?: unknown;
  }) => void;
}

/**
 * Agent-CLI interrupt handler spanning active turns and idle queue waits.
 * Follow-ups join its queue; flow-only controls such as compaction ignore it.
 *
 * A running turn and the between-turn wait are reached through `signal`
 * alone: every strategy binds the turn it launches to it, a native turn's
 * flow subscribes to its own run signal downstream of that binding, and the
 * loop races its queue wait against it.
 */
class ChildRunInterruptible implements RunInterruptHandler {
  private readonly controller = new AbortController();

  constructor(
    /**
     * Only a strategy that declares `ownsBackgroundProcess` sets this: a
     * loop-level handler for an agent child must stay invisible to shutdown
     * drain so restart recovery still finds it (#8155).
     */
    readonly ownsBackgroundProcess: boolean,
  ) {}

  interrupt(): void {
    this.controller.abort();
  }

  isInterrupted(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * The one cancellation signal every turn of this child runs under. No turn
   * starts after an interrupt (the loop checks `isInterrupted()` first), so a
   * per-turn controller would only ever mirror this one.
   */
  get signal(): AbortSignal {
    return this.controller.signal;
  }
}

const CHANNEL = 'childRunLoop';

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

/** Log a turn summary (duration + token usage) to the child stream. */
const logTurnSummary = (
  trace: AgentTrace | undefined,
  wallTimeMs: number,
  usage: TurnUsage | null | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* loopLog(
      trace,
      'info',
      `Turn completed in ${formatDuration(wallTimeMs)}`,
    );
    if (usage) {
      yield* loopLog(trace, 'info', 'Tokens', {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      });
    }
  });

/** Outcome of a single turn attempt, flattening the loop's inner try/catch. */
type TurnAttempt<TTurn> =
  | { kind: 'completed'; turn: TTurn; turnIsError: boolean }
  | { kind: 'failed'; err: unknown }
  | { kind: 'interrupted' };

/**
 * Run one turn (via `runner`) and classify the outcome. A clean interruption
 * maps to `interrupted` (the caller breaks), a thrown call to `failed`, and a
 * returned turn to `completed` (carrying its application-level error flag).
 */
function attemptTurn<TTurn, R>(
  strategy: ChildRunStrategy<TTurn, R>,
  runner: (signal: AbortSignal) => Effect.Effect<TTurn, Error, R>,
  loop: ChildRunInterruptible,
  trace: AgentTrace | undefined,
  startedAt: number,
): Effect.Effect<TurnAttempt<TTurn>, never, R> {
  return Effect.gen(function* () {
    const attempt = yield* Effect.exit(
      Effect.gen(function* () {
        const turn = yield* runner(loop.signal);
        yield* logTurnSummary(
          trace,
          Date.now() - startedAt,
          strategy.getUsage?.(turn),
        );
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
 * under (#9531). A turn that ran queued follow-ups as its prompt takes its
 * identity from the prompt's durable rows, not from the attempt: the parent
 * row is admitted before this child's settlement consumes the prompt, so a
 * crash between the two re-executes the prompt under a new attempt id, and
 * only the prompt-anchored id lets admission judge the second delivery a
 * replay of the first instead of handing the parent both results. Every
 * other turn takes the `child.turn` row's key (run, attempt, turn index).
 * Neither is persisted beside its row, so the two can never disagree. The
 * turn-key form stays distinct across attempts, even when a workflow
 * deliberately reuses its run id, so a later workflow run cannot collide
 * with its prior delivery.
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
 * Debug-only turn identity, owner and interruption facts (#9531). These are
 * driver diagnostics; the child's output remains its provider's narrative.
 */
function emitTurnDiagnostic(
  trace: AgentTrace | undefined,
  event: 'turn.accepted' | 'turn.delivered' | 'loop.terminated',
  params: {
    runId: RunId;
    turn?: AttemptKey;
    queueOwner?: FollowUpConsumerLease;
    interruptionCause?: ChildLoopTerminationCause;
  },
): Effect.Effect<void> {
  const { runId, turn, queueOwner, interruptionCause } = params;
  return loopLog(trace, 'debug', `childRunLoop ${event}`, {
    runId,
    ...(turn ? { attemptId: turn.key, turnIndex: turn.index } : {}),
    ...(queueOwner ? { queueOwner: queueOwner.kind } : {}),
    ...(interruptionCause ? { interruptionCause } : {}),
  });
}

/**
 * Commit one turn's `child.turn` row (#9531), the fact the report/result
 * slots are attributed from. Not best-effort: a refused append is the turn's
 * failure. `not-owner` means this process no longer holds the run and the
 * loop stops rather than deliver under a claim it lost (R7); a write failure
 * is a fact the slots cannot be labeled without.
 *
 * An agent-CLI turn's settlement also consumes the follow-ups that were its
 * prompt (C3): no ledger message carries that prompt, and its provider's
 * thread holds it only once the turn has run, so the rows stay queued until
 * then. The parent delivery is admitted before this commit, so a crash after
 * settlement still leaves the result on the parent; a crash before it
 * re-delivers the prompt to the next loop, whose re-executed turn admits its
 * result under the same prompt-anchored delivery id, so the parent is not
 * handed both results. A turn whose own result persistence failed settles
 * with no consumption at all, so its prompt stays queued for that loop.
 */
function commitChildTurn(
  session: SessionHandle,
  runId: RunId,
  turn: AttemptKey,
  phase: 'accepted' | 'settled',
  consumed: readonly QueuedFollowUp[] = [],
): Effect.Effect<void, DatabaseNotOwner | DatabaseWriteFailed> {
  return session
    .commit([
      ...consumed.map((followUp) => ({
        type: 'followup.consumed' as const,
        aggregateId: aggregateId('run', runId),
        followUpId: followUp.followUpId,
      })),
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
 * Move an agent-CLI child's phase across its park (one run model, 3.3):
 * `parked` before the loop blocks on its queue, `resumed` when the taken
 * batch starts the next turn. Its own row: a run this loop is the only
 * driver of has no ledger, no `flow.snapshot` and no rounds, so a borrowed
 * `flow.step` had to invent a `toolUse` family, a round 0 and a continuation
 * index that named nothing. Without the park row the run stays RUNNING while
 * idle and `getToolUseFollowUpTarget` classifies the next turn's submission
 * as `no_session`; native children park through their own loop's `waiting`
 * step and are never written here, so each park keeps one writer.
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

/**
 * A turn's parent-follow-up enqueue, still pending its wake step. Waking can
 * await the resumed parent's entire turn (`agentResume.tryResumeRun` → …
 * → `resumeToolUseFromResumeData`), so callers that are about to finalize this
 * child (terminal/failed turns) must resolve the wake only AFTER that
 * finalize completes; otherwise a resumed parent that immediately waits on
 * this still-RUNNING run self-stalls (#8093). Callers that continue to
 * another turn (no finalize pending) may wake immediately.
 */
interface PendingChildDelivery {
  readonly parent: RunParent;
  readonly followUp: FollowUpQueueInput;
  /**
   * The parent follow-up row is already durable. A recovery lease means this
   * process still has to wake the parent after this child's finalize; a
   * deferred live offer carries no lease, and the resubmit in
   * `submitPendingDelivery` offers the durable row to the live parent at
   * that same post-finalize point.
   */
  readonly recovery?: FollowUpRecoveryLease;
}

/**
 * A turn result with nowhere to go: the child detached from its orchestrator,
 * so the report slot is the only place the outcome survives. Shared by the
 * enqueue site and the deferred wake site, which resolve the target at
 * different times.
 */
const warnDetachedChildDelivery = (
  trace: AgentTrace | undefined,
  runId: RunId,
): Effect.Effect<void> =>
  loopLog(
    trace,
    'warn',
    'Turn result not delivered: child was detached from its orchestrator. The result remains in the run report.',
    { runId },
  );

/**
 * Format, persist, and enqueue one turn's outcome on the parent's follow-up
 * queue; the loop's single delivery site, shared by every interim and
 * terminal turn, every strategy. Returns the pending delivery for the caller
 * to wake via {@link submitPendingDelivery} once its own ordering allows it;
 * `undefined` when there is nothing to wake (detached child, or delivery
 * skipped by `prepareParentDelivery`).
 */
const deliverTurn = Effect.fn('childRunLoop.deliverTurn')(function* <
  TTurn,
  R,
>(params: {
  session: SessionHandle;
  strategy: ChildRunStrategy<TTurn, R>;
  runId: RunId;
  trace: AgentTrace | undefined;
  turn: TTurn | null;
  turnKey: AttemptKey;
  /** The queued follow-ups this turn ran as its prompt. */
  consumed: readonly QueuedFollowUp[];
  err: unknown;
  wallTimeMs: number;
  isError: boolean;
  finalizing: boolean;
  prepareParentDelivery?: () => boolean;
  parent: RunParent;
  onTurnSettled?: ChildRunLoopParams<TTurn>['onTurnSettled'];
}): Effect.fn.Return<PendingChildDelivery | undefined, Error, R> {
  const {
    strategy,
    runId,
    trace,
    turn,
    turnKey,
    err,
    wallTimeMs,
    isError,
    prepareParentDelivery,
    parent,
  } = params;
  const delivered = turn != null && !isError;
  const msg = delivered
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
  // The settled facts reach the caller whether or not they persisted: a
  // durable caller decides from them what a missing manifest means. The
  // persistence failure is then this turn's failure, thrown once the turn
  // is settled, and the delivery never reaches the parent.
  const persisted = yield* Effect.exit(
    persistChildRunDelivery(params.session, runId, msg, resultMeta),
  );
  const followUp: FollowUpQueueInput = {
    text: msg,
    origin: 'subagent_result',
    deliveryId: turnDeliveryId(runId, turnKey, params.consumed),
  };
  let pending: PendingChildDelivery | undefined;
  if (Exit.isSuccess(persisted) && strategy.deliveryMode !== 'persistOnly') {
    const targetRunId = parent.current ?? undefined;
    if (!targetRunId) {
      yield* warnDetachedChildDelivery(trace, runId);
    } else if (prepareParentDelivery?.() !== false) {
      // Admit the parent row before consuming the prompt: a crash after
      // settlement then still leaves the result on the parent, and a crash
      // before it re-executes the prompt under the same delivery id, which
      // admission judges a replay. A turn this loop finalizes after
      // (failed, terminal, or a strategy with no next turn) defers the live
      // offer until that finalize has run, so a live parent cannot wake and
      // wait on a child that still reports RUNNING (#8093); the deferred
      // resubmit in submitPendingDelivery offers the durable row then.
      const finalizing = params.finalizing;
      const submitted = yield* params.session.followUps.submit(
        targetRunId,
        followUp,
        'recoverable',
        { liveOffer: finalizing ? 'deferred' : 'immediate' },
      );
      if (submitted.kind === 'refused') {
        yield* loopLog(
          trace,
          'warn',
          `Turn result not delivered: parent run is unavailable (${submitted.reason ?? 'not_resumable'}). The result remains in the run report.`,
          { runId, parentRunId: targetRunId, reason: submitted.reason },
        );
      } else {
        pending = {
          parent,
          followUp,
          ...(submitted.kind === 'queued' && submitted.lease
            ? { recovery: submitted.lease }
            : {}),
        };
      }
    }
  }
  // The turn settled whatever the delivery persistence did: its settle path
  // ran, which is the fact a recovering caller's re-execution gate reads (a
  // settled `child.turn` under a run with no outcome refuses repetition,
  // manifest or not, since the manifest is written for a failed delivery
  // too and so cannot say whether the turn succeeded), so the row lands
  // before that failure is raised. The prompt's consumption commits only
  // when its result is durable: when persistence failed, no report and no
  // parent row carries the outcome, so the prompt rows stay queued for the
  // relaunched loop to deliver again rather than recording the turn as spent.
  yield* commitChildTurn(
    params.session,
    runId,
    turnKey,
    'settled',
    Exit.isSuccess(persisted) ? params.consumed : [],
  );

  params.onTurnSettled?.({
    message: msg,
    ...(resultMeta !== undefined && { resultMeta }),
    isError,
    ...(err != null && { error: err }),
  });
  if (Exit.isFailure(persisted))
    return yield* Effect.failCause(persisted.cause);
  return pending;
});

/**
 * Resolve a pending delivery's wake step (no-op when there is nothing to
 * wake, or the enqueue itself found no session; already logged above).
 */
const submitPendingDelivery = Effect.fn('submitPendingDelivery')(function* (
  pending: PendingChildDelivery | undefined,
  session: SessionHandle,
  runId: RunId,
  trace: AgentTrace | undefined,
): Effect.fn.Return<void, Error, AgentResume> {
  if (!pending) return;
  const targetRunId = pending.parent.current ?? undefined;
  if (!targetRunId) {
    yield* warnDetachedChildDelivery(trace, runId);
    return;
  }
  /** The parent could not be resumed; its result still awaits an explicit resume. */
  const warnParentNotResumed = loopLog(
    trace,
    'warn',
    'Turn result queued for the parent, but the parent could not be resumed; an explicit Resume delivers it.',
    { runId, parentRunId: targetRunId },
  );
  const recovery = pending.recovery;
  if (recovery) {
    const resumed = yield* startFollowUpWake(targetRunId, recovery, session);
    if (!resumed) yield* warnParentNotResumed;
  }
  // Duplicate-safe: the parent row was admitted before the child prompt
  // was consumed. This wake still goes through submitFollowUp so a mocked
  // delivery site (and a live parent that needs no recovery lease) still
  // sees it at the original post-finalize point.
  const delivery = yield* submitFollowUp(targetRunId, pending.followUp, {
    session,
  });
  if (delivery.status === 'failed') {
    yield* loopLog(
      trace,
      'warn',
      `Turn result not delivered: parent run is unavailable (${delivery.reason}). The result remains in the run report.`,
      { runId, parentRunId: targetRunId, reason: delivery.reason },
    );
  } else if (delivery.status === 'queued' && delivery.wake === 'failed') {
    yield* warnParentNotResumed;
  }
});

/**
 * The child loop's abort as an Effect: it settles with `outcome()` the moment
 * `signal` aborts, and never otherwise. Built per race, so the outcome is
 * constructed only when the abort actually fires.
 */
function onceAborted<A, E>(
  signal: AbortSignal,
  outcome: () => Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.callback<A, E>((resume) => {
    const detach = onAbort(signal, () => resume(outcome()));
    return Effect.sync(detach);
  });
}

/** Race a queue wait against the child loop's interrupt; null when stopped. */
function untilInterrupted<A>(
  wait: Effect.Effect<A>,
  loop: ChildRunInterruptible,
): Effect.Effect<A | null> {
  return Effect.raceFirst(
    wait,
    onceAborted(loop.signal, () => Effect.succeed(null)),
  ).pipe(Effect.interruptible);
}

/**
 * Own admitted run cleanup until the child loop takes over. Failure or
 * interruption records the terminal outcome and releases the run's claim
 * before propagating the original cause. Post-handoff work stays outside
 * this owner because the live child then owns its own settlement.
 */
export function runWithOwnedRunLeaseLaunchGuard<A, E, R>(
  session: SessionHandle,
  runId: RunId,
  operation: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> {
  return operation.pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit)) return Effect.void;
      return Effect.gen(function* () {
        const finalized = yield* Effect.exit(
          finalizeRun(session, {
            runId,
            outcome: Cause.hasInterrupts(exit.cause)
              ? RUN_OUTCOME.CANCELLED
              : RUN_OUTCOME.FAILED,
          }),
        );
        const released = yield* Effect.exit(session.releaseRunLease(runId));
        const failures: unknown[] = [];
        if (Exit.isFailure(finalized))
          failures.push(Cause.squash(finalized.cause));
        else if (!finalized.value.ok) failures.push(finalized.value.error);
        if (Exit.isFailure(released))
          failures.push(Cause.squash(released.cause));
        if (failures.length > 0)
          return yield* Effect.fail(
            new AggregateError(failures, `Run ${runId} launch cleanup failed`),
          );
      });
    }),
  );
}

/**
 * Own one child's delivery, queue, concurrency budget and terminal cleanup.
 * Native launches call turn boundaries from their live scope; process
 * strategies return a turn and wait for their next batch here.
 */
export function startChildRunLoop<TTurn, R = never>(
  params: ChildRunLoopParams<TTurn, R>,
): Effect.Effect<
  Fiber.Fiber<TTurn | undefined, Error>,
  Error,
  R | Runs | AgentResume
> {
  return Effect.gen(function* () {
    const runSession = params.session;
    const runs = yield* Runs;
    const budget = params.budgeted
      ? yield* runs.childRunBudget(
          yield* resolveChildRunConcurrencyBudget(runSession.roots),
        )
      : undefined;
    const { childRun, parentRunId, runId, agentName, strategy } = params;
    // An agent-CLI child presents on its own trace; `loopLog` sends every
    // other child's driver diagnostics to the process log.
    const trace = childRun?.logger;
    const loop = new ChildRunInterruptible(
      strategy.ownsBackgroundProcess === true,
    );
    // Retain native lineage through launch and final delivery, outside the
    // engine handle's lifetime. Process children have their stream already.
    const parent = runs.getHandle(runId)?.parentState ?? {
      current: parentRunId,
    };
    const releaseChildActivation = childRun
      ? () => undefined
      : runs.reserveChildActivation({
          runId,
          parent,
          interrupt: () => loop.interrupt(),
        });
    let sessionOwnershipReleased = false;
    const releaseSessionOwnershipOnce = (): void => {
      if (sessionOwnershipReleased) return;
      sessionOwnershipReleased = true;
      strategy.releaseSessionOwnership?.();
    };

    let input!: RunInput;
    let queueLease: FollowUpConsumerLease | undefined;
    let detachLoopInterrupt: (() => void) | undefined;
    let sessionStage: StageHandle | undefined;
    // Unwind setup and lane refusals before the run body takes ownership.
    const unwindSetup = (error: unknown): Effect.Effect<Error> =>
      Effect.gen(function* () {
        const cleanupErrors: unknown[] = [];
        const cleanups = [
          () => sessionStage?.end(RUN_OUTCOME.FAILED),
          () => detachLoopInterrupt?.(),
          () => {
            if (queueLease)
              runSession.followUps.release(queueLease, 'terminal');
          },
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

    const created = yield* RunInput.make;
    // Fresh children already own their DB claim. Recovery retains its pending
    // queue until the run lane acquires the claim and transfers it below.
    const claimed = yield* Effect.exit(
      Effect.sync(() => {
        queueLease =
          params.queueLease ?? runSession.followUps.claimChildRun(runId);
        if (!queueLease) {
          throw new Error(
            `Follow-up continuation already has an owner for child ${runId}.`,
          );
        }
        if (!params.queueLease)
          input = runSession.followUps.attachInput(runId, created, queueLease)!;
      }),
    );
    if (Exit.isFailure(claimed)) {
      return yield* Effect.fail(
        yield* unwindSetup(Cause.squash(claimed.cause)),
      );
    }
    const setup = yield* Effect.exit(
      Effect.gen(function* () {
        // An agent-CLI child has no flow to fold: its loop seeds the queue
        // from the run's rows itself, so follow-ups a crash left queued (or a
        // turn it never settled) reach the relaunched loop. A native child's
        // resumed flow seeds the same queue from its own load.
        const folded = !strategy.continuous
          ? foldRunState(
              null,
              yield* runSession.readAggregate(aggregateId('run', runId)),
            )
          : null;
        yield* Effect.sync(() => {
          strategy.onLoopStart?.(runSession);
          if (folded !== null) {
            if (Result.isFailure(folded)) {
              throw new Error(
                `Child run ${runId} has rows its follow-up queue cannot be seeded from: ${folded.failure.detail}`,
                { cause: folded.failure },
              );
            }
            input.seed(
              folded.success?.followUps ?? [],
              folded.success?.followUpIds,
            );
          }
          if (!strategy.continuous) {
            detachLoopInterrupt = runs
              .getHandle(runId)
              ?.attachInterruptHandler(loop);
          }
          sessionStage = trace?.openStage(strategy.stageLabel);
        });
      }),
    );
    if (Exit.isFailure(setup)) {
      return yield* Effect.fail(yield* unwindSetup(Cause.squash(setup.cause)));
    }

    const attemptId = randomUUID();
    let bestCostUsd: number | undefined;
    // Progress reaches the parent as queued follow-ups. The port is
    // synchronous, so it admits each one where it is reported (the target and
    // the admission decided then) and one drainer the loop's body owns writes
    // the rows in that order.
    const notices = yield* Queue.unbounded<
      Effect.Effect<void, Error>,
      Cause.Done
    >();
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
        // The target and the admission are decided where the progress is
        // reported; the queued effect writes the row, and nothing is queued
        // when no session holds the run.
        if (
          runSession.runs.getToolUseFollowUpTarget(targetRunId).kind !==
          'no_session'
        ) {
          Queue.offerUnsafe(
            notices,
            Effect.asVoid(
              runSession.followUps.submit(
                targetRunId,
                {
                  text: formatSubagentProgress(runId, agentName, update),
                  origin: 'subagent_result',
                },
                'live_owner',
              ),
            ),
          );
        }
      },
      recordCost: (totalCost) => {
        if (totalCost !== undefined) {
          bestCostUsd = Math.max(bestCostUsd ?? 0, totalCost);
        }
      },
    };

    let sawTurnFailure = false;
    let lastTurnErr: unknown;
    // Terminal delivery wakes only after the child's finalization and claim
    // release. Interim delivery wakes immediately, while the child stays live.
    let pendingDelivery: PendingChildDelivery | undefined;
    // Acquire the concurrency slot only while a turn runs.
    const gateTurn = (
      base: (signal: AbortSignal) => Effect.Effect<TTurn, Error, R>,
    ): ((signal: AbortSignal) => Effect.Effect<TTurn, Error, R>) =>
      budget === undefined
        ? base
        : (signal) =>
            Effect.raceFirst(
              budget.withPermit(Effect.uninterruptible(base(signal))),
              onceAborted(signal, () =>
                Effect.fail(
                  new Error(
                    'Child run turn cancelled while awaiting a concurrency slot.',
                  ),
                ),
              ),
            ).pipe(Effect.interruptible);

    let runStarted = false;
    const run = Effect.gen(function* () {
      runStarted = true;
      let turnIndex = 0;
      let result: TTurn | undefined;
      const body = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            if (params.queueLease) {
              // Only this lane's driver can adopt recovery; its terminal
              // cleanup releases the DB claim after final delivery preparation.
              yield* runSession.acquireClaims(aggregateId('run', runId));
              queueLease = runSession.followUps.claimChildRun(
                runId,
                params.queueLease,
              );
              if (!queueLease)
                return yield* Effect.fail(
                  new Error(`Child recovery ownership was lost for ${runId}.`),
                );
              input = runSession.followUps.attachInput(
                runId,
                created,
                queueLease,
              )!;
            }
            const runNotice = (notice: Effect.Effect<void, Error>) =>
              notice.pipe(
                Effect.catch((error) =>
                  loopLog(trace, 'warn', 'Child progress was not queued', {
                    runId,
                    error,
                  }),
                ),
              );
            const drainer = yield* Effect.forkScoped(
              Effect.gen(function* () {
                for (;;) {
                  const notice = yield* Queue.take(notices).pipe(
                    Effect.catchTag('Done', () => Effect.succeed(null)),
                  );
                  if (notice === null) return;
                  yield* runNotice(notice);
                }
              }),
            );
            // Notices await SQLite admission. Offer a sentinel so the
            // drainer finishes every progress job already queued before a
            // parent result can commit (otherwise the result is a separate
            // stale model turn).
            const drainNotices = Effect.gen(function* () {
              const done = yield* Deferred.make<void>();
              yield* Queue.offer(notices, Deferred.succeed(done, undefined));
              yield* Deferred.await(done);
            });
            yield* Effect.addFinalizer(() =>
              Queue.end(notices).pipe(
                Effect.andThen(Fiber.await(drainer)),
                Effect.asVoid,
              ),
            );
            let consumed: readonly QueuedFollowUp[] = [];
            let turnStartedAt = Date.now();
            const beginTurn = Effect.gen(function* () {
              turnIndex += 1;
              turnStartedAt = Date.now();
              const turnKey = { key: attemptId, index: turnIndex };
              yield* emitTurnDiagnostic(trace, 'turn.accepted', {
                runId,
                turn: turnKey,
                queueOwner: queueLease,
              });
              yield* commitChildTurn(runSession, runId, turnKey, 'accepted');
            });
            const settleTurn = (
              turn: TTurn | null,
              err: unknown,
              turnIsError: boolean,
              finalizing: boolean,
            ) =>
              Effect.gen(function* () {
                const turnKey = { key: attemptId, index: turnIndex };
                const wallTimeMs = Date.now() - turnStartedAt;
                const turnFailed = err != null || turnIsError;

                if (turn != null) {
                  strategy.publishUsage?.(turn);
                }

                // Progress notices are admitted on the forked drainer and can
                // lag the turn; deliverTurn persists the report and admits the
                // parent row, so drain first or the result commits ahead of
                // progress the parent then receives as a separate stale turn.
                yield* drainNotices;
                return yield* deliverTurn({
                  session: runSession,
                  strategy,
                  runId,
                  parent,
                  trace,
                  turn,
                  turnKey,
                  consumed,
                  err,
                  wallTimeMs,
                  isError: turnFailed,
                  finalizing,
                  onTurnSettled: params.onTurnSettled,
                  prepareParentDelivery: () => {
                    if (!childRun && parent.current === null) return false;
                    if (loop.isInterrupted()) {
                      releaseSessionOwnershipOnce();
                      return strategy.deliverAfterInterrupt === true;
                    }
                    if (turnFailed) {
                      releaseSessionOwnershipOnce();
                    } else if (turn != null) {
                      strategy.onTurnSuccess?.(turn, runSession);
                    }
                    return true;
                  },
                });
              });
            const turns: ChildRunTurns<TTurn, R> = {
              run: (operation) =>
                Effect.gen(function* () {
                  if (loop.isInterrupted()) return yield* Effect.interrupt;
                  yield* beginTurn;
                  return yield* budget
                    ? budget.withPermit(operation)
                    : operation;
                }),
              complete: (turn) =>
                Effect.gen(function* () {
                  const delivery = yield* settleTurn(turn, null, false, false);
                  yield* submitPendingDelivery(
                    delivery,
                    runSession,
                    runId,
                    trace,
                  );
                }).pipe(Effect.uninterruptible),
            };
            let runner: (
              signal: AbortSignal,
            ) => Effect.Effect<TTurn, Error, R> = (signal) =>
              strategy.launch(ports, signal, turns);
            while (!loop.isInterrupted()) {
              if (!strategy.continuous) yield* beginTurn;
              const attempt = yield* attemptTurn(
                strategy,
                strategy.continuous ? runner : gateTurn(runner),
                loop,
                trace,
                turnStartedAt,
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
              const finalizing =
                turnFailed ||
                turn == null ||
                strategy.isTerminal(turn) ||
                !strategy.runTurn;
              // A launch failure can terminate before its first model cycle.
              if (turnIndex === 0) {
                if (err != null && !(yield* runSession.ownsRun(runId)))
                  return yield* Effect.fail(ensureError(err));
                yield* beginTurn;
              }
              const delivery = yield* settleTurn(
                turn,
                err,
                turnIsError,
                finalizing,
              );
              const turnKey = { key: attemptId, index: turnIndex };
              yield* emitTurnDiagnostic(trace, 'turn.delivered', {
                runId,
                turn: turnKey,
                queueOwner: queueLease,
              });

              if (turnFailed) {
                sawTurnFailure = true;
                lastTurnErr =
                  err ??
                  new Error(
                    `${strategy.stageLabel} reported a failed turn without throwing.`,
                  );
                pendingDelivery = delivery;
                break;
              }

              const isTerminal = turn != null && strategy.isTerminal(turn);
              if (isTerminal || !strategy.runTurn) {
                pendingDelivery = delivery;
                break;
              }

              // Process strategies wake the parent before waiting for input.
              yield* submitPendingDelivery(delivery, runSession, runId, trace);
              if (loop.isInterrupted()) break;

              // The park is durable before the block, so a follow-up arriving
              // while this loop sleeps is admitted onto its queue instead of
              // being refused against a run that only looks busy.
              yield* commitPark(runSession, runId, 'parked');
              const nextRunTurn = strategy.runTurn;
              const batch = yield* untilInterrupted(input.take, loop);
              if (!batch || loop.isInterrupted()) break;
              // The batch leaves the park: the loop is running again from
              // here, and the turn it is about to accept is the top's.
              const taken = batch.synthetic ? [] : batch.followUps;
              yield* commitPark(runSession, runId, 'resumed');
              consumed = taken;
              const prompts: readonly FollowUpContent[] = batch.synthetic
                ? [{ text: batch.text, origin: 'user' }]
                : taken.map((followUp) => followUp.content);
              runner = (signal) => nextRunTurn(prompts, ports, signal);
            }
          }),
        ),
      );
      if (Exit.isFailure(body)) {
        const error = Cause.squash(body.cause);
        sawTurnFailure = true;
        lastTurnErr ??= error;
        // A lost aggregate claim: this process no longer owns the run, so
        // the loop stops rather than continue under it.
        if (error instanceof DatabaseNotOwner) loop.interrupt();
      }

      const terminal = yield* Effect.exit(
        Effect.gen(function* () {
          detachLoopInterrupt?.();
          let terminationCause: ChildLoopTerminationCause = 'terminal';
          if (loop.isInterrupted()) terminationCause = 'interrupted';
          else if (sawTurnFailure) terminationCause = 'turn_failed';
          yield* emitTurnDiagnostic(trace, 'loop.terminated', {
            runId,
            queueOwner: queueLease,
            interruptionCause: terminationCause,
          });
          if (queueLease) runSession.followUps.release(queueLease, 'terminal');
          releaseSessionOwnershipOnce();
          yield* Effect.forkDetach(
            Effect.try({
              try: () => params.recordCost?.(bestCostUsd),
              catch: ensureError,
            }).pipe(
              Effect.catch((error) =>
                loopLog(trace, 'warn', 'Child cost observer failed', error),
              ),
            ),
            { startImmediately: true },
          );

          const outcome = deriveRunOutcome({
            failed: sawTurnFailure,
            cancelled: loop.isInterrupted(),
          });
          if (childRun) {
            yield* childRun.finalize({
              outcome,
              error: lastTurnErr,
              stage: sessionStage,
            });
          } else {
            // Startup may fail before the engine owns terminal finalization.
            const handle = runs.getHandle(runId);
            if (handle) {
              yield* finalizeRunTerminal({
                session: runSession,
                handle,
                outcome,
                error:
                  sawTurnFailure && lastTurnErr !== undefined
                    ? {
                        kind: classifyAgentError(lastTurnErr),
                        message: toErrorMessage(lastTurnErr),
                      }
                    : undefined,
              });
            } else if (
              (loop.isInterrupted() || sawTurnFailure) &&
              (yield* runSession.ownsRun(runId))
            ) {
              // Failure or cancellation can precede the engine's first handle.
              const finalized = yield* finalizeRun(runSession, {
                runId,
                outcome,
                keepExistingOutcome: true,
              });
              if (!finalized.ok)
                return yield* Effect.fail(ensureError(finalized.error));
            }
          }
        }),
      );
      const released = yield* Effect.exit(runSession.releaseRunLease(runId));
      if (Exit.isFailure(released)) {
        yield* loopLog(
          trace,
          'warn',
          'Failed to persist final child-run artifacts',
          { runId, error: Cause.squash(released.cause) },
        );
      }
      // The parent may immediately read this child; release its claim first.
      const delivery = yield* Effect.exit(
        submitPendingDelivery(pendingDelivery, runSession, runId, trace),
      );
      const activation = yield* Effect.exit(
        Effect.sync(releaseChildActivation),
      );
      const failures = [body, terminal, released, delivery, activation].flatMap(
        (exit) => (Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : []),
      );
      if (failures.length > 0) {
        return yield* Effect.fail(
          ensureError(aggregateError(failures, 'Child run and cleanup failed')),
        );
      }
      return result;
    }).pipe(Effect.uninterruptible);
    return yield* Effect.forkDetach(
      runs.launchRun(runId, run).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = runStarted
              ? ensureError(Cause.squash(cause))
              : yield* unwindSetup(Cause.squash(cause));
            return yield* Effect.fail(error);
          }),
        ),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.fail(ensureError(Cause.squash(cause)))),
    Effect.uninterruptible,
  );
}
