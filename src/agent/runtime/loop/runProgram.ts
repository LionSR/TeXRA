/**
 * The run programs' shared scaffolding: the one state cell every run writes
 * through, the entry both loops take, and the exit protocol every run
 * settles. One mechanism with two call sites (`toolUse.ts`,
 * `reflection.ts`); what the families do inside their loops stays in their
 * own files. There is no family parameter and no hook record: the shared
 * surface is values and total functions, and each loop writes its own
 * three-argument `Effect.acquireUseRelease` (the run-loop design,
 * .agents/docs/proposed/architecture/2026-09-21-effect-design-run-loop-programs.md).
 */

import { Cause, Effect, Exit, Ref, SynchronizedRef } from 'effect';

import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  AgentRunStateSnapshotSchema,
  RUN_OUTCOME,
  type AgentRunStateSnapshot,
  type NormalizedUsage,
  type RunFamily,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import type { DatabaseWriteFailed } from '@shared/session/database';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import {
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
 * has rows and a phase" is the acquire's postcondition.
 */
export interface RunCell {
  readonly runId: RunId;
  /** The state the loop continues from. Nothing mirrors it. */
  readonly current: Effect.Effect<RunState>;
  /**
   * Commit one batch against the current state and adopt what the ledger
   * folds back. Read-append-write is one uninterruptible region, so a stop
   * can never leave the cell behind the rows: the halt the release writes
   * always folds onto the state every committed batch produced.
   */
  readonly append: (
    rows: readonly RunLedgerDraft[],
  ) => Effect.Effect<RunState, RunLedgerRefused | DatabaseWriteFailed>;
  /**
   * Adopt a state a run service already committed against (the invoker, the
   * dispatch unit, the follow-up consumer, the compaction).
   */
  readonly adopt: (state: RunState) => Effect.Effect<RunState>;
}

/**
 * A `Ref`, not a `SynchronizedRef`: one fiber owns a run — the loop, the
 * invoker and the dispatcher all run on it — so a lock would be a primitive
 * bought against no contention.
 */
export const makeRunCell = (
  runId: RunId,
  opened: RunState,
): Effect.Effect<RunCell, never, RunLedger> =>
  Effect.gen(function* () {
    const ledger = yield* RunLedger;
    const ref = yield* Ref.make(opened);
    return {
      runId,
      current: Ref.get(ref),
      append: (rows) =>
        Ref.get(ref).pipe(
          Effect.flatMap((state) => ledger.appendBatch(runId, state, rows)),
          Effect.tap((next) => Ref.set(ref, next)),
          Effect.uninterruptible,
        ),
      adopt: (state) => Ref.set(ref, state).pipe(Effect.as(state)),
    } satisfies RunCell;
  });

/**
 * Record one round's usage against the binding that served it. A manual retry
 * may have rebound the model inside the invoker, so the price is charged
 * against `run.model`'s current value rather than whatever the round started
 * with. Both loops call this after a successful round.
 */
export const recordServedUsage = (
  run: Pick<AgentRunShape, 'model' | 'usageMonitor'>,
  snapshot: AgentRunStateSnapshot,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const served = yield* SynchronizedRef.get(run.model);
    yield* Effect.sync(() => run.usageMonitor.recordUsage(snapshot, served));
  });

/** Build the turn's usage record from the ledger's folded totals. */
export const usageSnapshot = (
  state: RunState,
  totalRounds: number,
  totalResponseTimeMs: number,
  latestUsage: NormalizedUsage | null,
): AgentRunStateSnapshot =>
  AgentRunStateSnapshotSchema.parse({
    totalRounds,
    totalResponseTimeMs,
    usageAccumulator: { totals: state.usage, latestUsage },
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
 * The one verdict: the body's own value when it returned, and on a failure
 * cause a stop only when every reason is an interrupt — a run that failed and
 * was then interrupted while unwinding is FAILED, never CANCELLED.
 */
const runVerdict = (exit: Exit.Exit<RunExit, Error>): RunOutcome | null =>
  Exit.match(exit, {
    onSuccess: (value) => value.outcome,
    onFailure: (cause) =>
      Cause.hasInterruptsOnly(cause)
        ? RUN_OUTCOME.CANCELLED
        : RUN_OUTCOME.FAILED,
  });

/**
 * The exit protocol, as the release arm of the run's acquireUseRelease: the
 * halt row and, where a family holds one, the input lease. A halt-write
 * failure only logs: the run is already unwinding and has nothing left to
 * surface it to.
 */
export const settleRun =
  (
    cell: RunCell,
    logger: AgentTrace,
    /** The family's input lease, or null. Typed data, not a service lookup:
     *  a missing FollowUps must not leak a lease with nothing saying so. */
    lease: FollowUps['Service'] | null,
  ) =>
  (exit: Exit.Exit<RunExit, Error>): Effect.Effect<void, never, Runs> =>
    Effect.gen(function* () {
      const outcome = runVerdict(exit);
      if (outcome !== null) {
        const state = yield* cell.current;
        yield* cell
          .append([haltedStepRow(cell.runId, state, outcome)])
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                logger.warn('Failed to record the run halt', { data: error }),
              ),
            ),
          );
      }
      if (lease !== null) {
        const runs = yield* Runs;
        lease.release(
          outcome === RUN_OUTCOME.COMPLETED &&
            !runs.hasActiveChildren(cell.runId)
            ? 'terminal'
            : 'recoverable',
        );
      }
    });

/**
 * The caller's error for a run that ended in a failure cause; a pure
 * interrupt cause is re-raised unchanged. A failure with an interrupt riding
 * alongside is a failure: the halt already recorded it as one.
 */
export const stoppedBy =
  (logger: AgentTrace, label: string) =>
  (cause: Cause.Cause<Error>): Effect.Effect<never, Error> => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
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
                Cause.hasInterruptsOnly(cause)
                  ? RUN_OUTCOME.CANCELLED
                  : RUN_OUTCOME.FAILED,
            }),
          ),
        ),
    );
