/**
 * The run programs' shared scaffolding: the one state cell every run writes
 * through, the entry both loops take, and the exit protocol every run
 * settles. One mechanism with two call sites (`toolUse.ts`,
 * `reflection.ts`); what the families do inside their loops stays in their
 * own files. There is no family parameter and no hook record: the shared
 * surface is values and total functions, and each loop writes its own
 * three-argument `Effect.acquireUseRelease` (the run-loop design,
 * .agents/docs/implemented/architecture/2026-09-21-effect-design-run-loop-programs.md).
 */

import { Cause, Effect, Exit, Result, SynchronizedRef } from 'effect';

import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  RUN_OUTCOME,
  type NormalizedUsage,
  type RunFamily,
  type RunId,
  type RunOutcome,
  type SessionEvent,
} from '@shared/schemas';
import type { DatabaseWriteFailed } from '@shared/session/database';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import {
  foldRunState,
  freshRunState,
  type RunLedgerDraft,
  type RunState,
} from '@shared/session/runStateFold';
import { ensureError } from '@utils/errors/errorMessage';

import { AgentRun, type AgentRunShape } from '../run/AgentRun';
import { Runs } from '../runRegistry';
import { haltedStepRow } from './rows';
import type { FollowUps } from '../FollowUps';

/**
 * The run's one state holder and its only ledger writer. Seeded with the
 * opened state inside the acquire, so no reader branches on null: "the run
 * has rows and a phase" is the acquire's postcondition. The loop hands the
 * same cell to the invoker and the dispatch unit, so no run service keeps a
 * copy of the state it commits against.
 */
export interface RunCell {
  readonly runId: RunId;
  /** The state the loop continues from. Nothing mirrors it. */
  readonly current: Effect.Effect<RunState>;
  /**
   * Commit one batch against the current state and adopt what the ledger
   * folds back. Rows that read the state (a snapshot, a step, a settlement
   * carrying the workspace) are built from the state the batch commits
   * against. Read-append-write is one uninterruptible region under the
   * cell's lock, so a stop can never leave the cell behind the rows, and
   * concurrent settlements of one parallel partition each fold onto the
   * latest state. The wait for the lock is masked too, deliberately: a
   * settlement queued behind a sibling when the run stops belongs to a tool
   * that already ran, and committing it keeps a resume from running it again.
   */
  readonly append: (
    rows:
      | readonly RunLedgerDraft[]
      | ((state: RunState) => readonly RunLedgerDraft[]),
  ) => Effect.Effect<RunState, RunLedgerRefused | DatabaseWriteFailed>;
  /**
   * Adopt a state a run service already committed against (the follow-up
   * consumer, the compaction).
   */
  readonly adopt: (state: RunState) => Effect.Effect<RunState>;
  /**
   * Fold a row another writer already committed (a `request.decided` the
   * decide command landed) onto the latest state, under the cell's lock, so
   * no append between the read and the write is lost. A row that does not
   * fold onto the run is a defect: `what` names it in the message.
   */
  readonly fold: (row: SessionEvent, what: string) => Effect.Effect<RunState>;
}

/**
 * A `SynchronizedRef`: the loop, the invoker and a barrier call run on one
 * fiber, but a parallel partition settles its calls on sibling fibers, and
 * each settlement must fold onto the one before it.
 */
export const makeRunCell = (
  runId: RunId,
  opened: RunState,
): Effect.Effect<RunCell, never, RunLedger> =>
  Effect.gen(function* () {
    const ledger = yield* RunLedger;
    const ref = yield* SynchronizedRef.make(opened);
    return {
      runId,
      current: SynchronizedRef.get(ref),
      append: (rows) =>
        SynchronizedRef.updateAndGetEffect(ref, (state) =>
          ledger.appendBatch(
            runId,
            state,
            typeof rows === 'function' ? rows(state) : rows,
          ),
        ).pipe(Effect.uninterruptible),
      adopt: (state) => SynchronizedRef.set(ref, state).pipe(Effect.as(state)),
      fold: (row, what) =>
        SynchronizedRef.updateAndGetEffect(ref, (state) => {
          const folded = foldRunState(state, [row]);
          return Result.isFailure(folded) || folded.success === null
            ? Effect.die(
                new Error(
                  `${what} does not fold onto the run: ${
                    Result.isFailure(folded)
                      ? folded.failure.detail
                      : 'no state'
                  }`,
                ),
              )
            : Effect.succeed(folded.success);
        }),
    } satisfies RunCell;
  });

/**
 * Record one round's usage against the binding that served it. A manual retry
 * may have rebound the model inside the invoker, so the price is charged
 * against `run.model`'s current value rather than whatever the round started
 * with. The totals are the ledger's folded ones, response time included.
 * Both loops call this after a successful round.
 */
export const recordServedUsage = (
  run: Pick<AgentRunShape, 'model' | 'usageMonitor'>,
  state: RunState,
  latestUsage: NormalizedUsage | null,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const served = yield* SynchronizedRef.get(run.model);
    yield* Effect.sync(() =>
      run.usageMonitor.recordUsage(state.usage, latestUsage, served),
    );
  });

/** Why a run the ledger holds no rows for cannot be continued. */
const NOT_RESUMABLE_MESSAGE =
  'This run was recorded before the run ledger and is not resumable under this release, and a request it left pending (an approval, a retry, a question) is not resumable either. Start a new run instead.';

export type RunEntry =
  /** No opening row yet. `loaded` may still carry queued follow-up rows. */
  | {
      readonly _tag: 'fresh';
      readonly loaded: RunState | null;
      readonly opening: RunState;
    }
  | { readonly _tag: 'restored'; readonly loaded: RunState };

/**
 * The run's entry, as data. Takes the claim when resuming, loads the
 * aggregate, and raises both refusals once — a resume with nothing to resume,
 * and a fresh launch onto an aggregate that already holds ledger state
 * (#11313). The family check both families need lives here too: a run resumed
 * under the wrong family fails loudly instead of continuing against an empty
 * workspace. The caller branches on the tag; `followUps.seed(entry.loaded)`
 * works on both arms without narrowing.
 */
export const loadRun = (
  runId: RunId,
  family: RunFamily,
  resume: boolean,
): Effect.Effect<RunEntry, Error, RunLedger | AgentRun> =>
  Effect.gen(function* () {
    const ledger = yield* RunLedger;
    if (resume) yield* ledger.acquire(runId);
    const loaded = yield* ledger.load(runId);
    if (loaded !== null && loaded.phase !== null) {
      if (!resume) {
        return yield* Effect.fail(
          new Error(
            `Run ${runId} already has ledger state; resume it instead.`,
          ),
        );
      }
      if (loaded.family !== family) {
        return yield* Effect.fail(
          new Error(`Run ${runId} is not a ${family} run; resume it as one.`),
        );
      }
      return { _tag: 'restored', loaded } satisfies RunEntry;
    }
    if (loaded === null && resume) {
      return yield* Effect.fail(new Error(NOT_RESUMABLE_MESSAGE));
    }
    const run = yield* AgentRun;
    const bound = yield* SynchronizedRef.get(run.model);
    return {
      _tag: 'fresh',
      loaded,
      opening: {
        ...freshRunState(0),
        family,
        modelId: bound.modelId,
        modelCompatibilityKey: bound.compatibilityKey,
        // The launch's own-API-key choice enters the ledger with the opening
        // snapshot, so every later binding and every resume reads it back.
        declinedRoutes: run.declinedRoutes,
      },
    } satisfies RunEntry;
  });

/**
 * What a run program returns. `outcome: null` is a park: the launch ended
 * without ending the run, so no `halted` step is written.
 */
export type RunExit = {
  readonly state: RunState;
  readonly outcome: RunOutcome | null;
};

/**
 * The one verdict: the body's own value when it returned. Any interrupt in
 * a failure cause is a stop, even when a finalizer then failed
 * (`Interrupt` + `Die`): `runUntilStopped` already reports that run
 * `CANCELLED`, so the halt row agrees.
 */
const runVerdict = (exit: Exit.Exit<RunExit, Error>): RunOutcome | null =>
  Exit.match(exit, {
    onSuccess: (value) => value.outcome,
    onFailure: (cause) =>
      Cause.hasInterrupts(cause) ? RUN_OUTCOME.CANCELLED : RUN_OUTCOME.FAILED,
  });

/**
 * The exit protocol, as the release arm of the run's acquireUseRelease: the
 * halt row and, where a family holds one, the input lease. A refused halt
 * write warns; a database write failure reaches the caller. The lease hangs
 * off that write's own exit: a failed halt still frees it, as `recoverable`,
 * because no terminal row landed.
 */
export const settleRun =
  (
    cell: RunCell,
    logger: AgentTrace,
    /** The family's input lease, or null. Typed data, not a service lookup:
     *  a missing FollowUps must not leak a lease with nothing saying so. */
    lease: FollowUps['Service'] | null,
  ) =>
  (
    exit: Exit.Exit<RunExit, Error>,
  ): Effect.Effect<void, DatabaseWriteFailed, Runs> => {
    const outcome = runVerdict(exit);
    const halt =
      outcome === null
        ? Effect.void
        : Effect.gen(function* () {
            const state = yield* cell.current;
            yield* cell
              .append([haltedStepRow(cell.runId, state, outcome)])
              .pipe(
                Effect.catch((error) =>
                  error instanceof RunLedgerRefused
                    ? Effect.sync(() =>
                        logger.warn('Failed to record the run halt', {
                          data: error,
                        }),
                      )
                    : Effect.fail(error),
                ),
              );
          });
    return halt.pipe(
      Effect.onExit((halted) =>
        lease === null
          ? Effect.void
          : Effect.gen(function* () {
              const runs = yield* Runs;
              lease.release(
                outcome === RUN_OUTCOME.COMPLETED &&
                  !runs.hasActiveChildren(cell.runId)
                  ? 'terminal'
                  : 'recoverable',
              );
            }),
      ),
    );
  };

/**
 * The caller's error for a run that ended in a failure cause. Any interrupt
 * in the cause is re-raised unchanged, so a stop that also hit a finalizer
 * stays a cancellation. Anything else becomes the caller's error.
 */
export const stoppedBy =
  (logger: AgentTrace, label: string) =>
  (cause: Cause.Cause<Error>): Effect.Effect<never, Error> => {
    if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
    const squashed = Cause.squash(cause);
    const stopped =
      squashed instanceof RunLedgerRefused
        ? new Error(
            `The run ledger refused a write (${squashed.reason}): ${squashed.detail}`,
            { cause: squashed },
          )
        : ensureError(squashed);
    logger.warn(`${label} stopped: ${stopped.message}`);
    return Effect.fail(stopped);
  };

/**
 * A trace stage whose verdict is the body's own exit. acquireUseRelease, not
 * a Scope: a Scope's finalizer sees `Exit<unknown, unknown>` and cannot read
 * the body's value, which is why both loops used to close their stage from a
 * mutable verdict instead.
 */
export const stagedBy =
  <A>(open: () => StageHandle, outcomeOf: (value: A) => RunOutcome) =>
  <E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(open),
      () => body,
      (stage, exit) =>
        Effect.sync(() =>
          stage.end(
            Exit.match(exit, {
              onSuccess: outcomeOf,
              onFailure: (cause) =>
                Cause.hasInterrupts(cause)
                  ? RUN_OUTCOME.CANCELLED
                  : RUN_OUTCOME.FAILED,
            }),
          ),
        ),
    );
