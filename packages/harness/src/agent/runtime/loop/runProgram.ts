/**
 * The run program's scaffolding: the one state cell every run writes
 * through, the run's entry, and the exit protocol every run settles. What
 * the loop does between them stays in `toolUse.ts`. There is no hook
 * record: the surface is values and total functions, and the loop writes its
 * own three-argument `Effect.acquireUseRelease` (the run-loop design,
 * .agents/docs/implemented/architecture/2026-09-21-effect-design-run-loop-programs.md).
 */

import { Cause, Effect, Exit, type Scope, SynchronizedRef } from 'effect';

import type { AgentTrace, StageHandle } from '@agent/trace';
import { RUN_OUTCOME, type RunId, type RunOutcome } from '@shared/schemas';
import type {
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from '@shared/session/database';
import { RunHistory, RunHistoryRefused } from '@shared/session/runHistory';
import type { CoWrite } from '@shared/session/sessionEvents';
import {
  freshRunState,
  type RunHistoryDraft,
  type RunState,
} from '@shared/session/runStateFold';
import { ensureError } from '@utils/errors/errorMessage';

import { AgentRun } from '../run/AgentRun';
import { Runs } from '../runRegistry';
import type { FollowUps } from '../FollowUps';

/** What a run cell's commits and re-reads fail with. */
export type CellError =
  RunHistoryRefused | DatabaseWriteFailed | DatabaseReadFailed;

/**
 * The run's one state holder and its only run history writer: the opening,
 * every step, settlement and delivery, the input it consumes, a compaction's
 * edit and a model switch all commit through {@link RunCell.append}, and
 * nothing sets the state it holds but what that folds back. Seeded inside
 * the acquire, so no reader branches on null: a resumed run's stored state,
 * or a fresh run's state before its opening batch. The loop hands the same
 * cell to the invoker and the dispatch unit, so no run service keeps a copy
 * of the state it commits against.
 */
export interface RunCell {
  readonly runId: RunId;
  /** The state the loop continues from. Nothing mirrors it. */
  readonly current: Effect.Effect<RunState>;
  /** The state the cell opened on: what a resume folded from stored rows,
   *  or a fresh run's before its opening batch. */
  readonly opened: RunState;
  /**
   * Commit one batch against the current state and hold what the run history
   * folds back. Rows that read the state (a step, a settlement, a delivery)
   * are built from the state the batch commits
   * against. Read-append-write is one uninterruptible region under the
   * cell's lock, so a stop can never leave the cell behind the rows, and
   * concurrent settlements of one parallel partition each fold onto the
   * latest state. The wait for the lock is masked too, deliberately: a
   * settlement queued behind a sibling when the run stops belongs to a tool
   * that already ran, and committing it keeps a resume from running it again.
   * `alongside` decides another aggregate's rows, appended with the batch
   * (`RunHistory.appendBatch`): a child turn's delivery to its parent.
   */
  readonly append: <E = never>(
    rows:
      | readonly RunHistoryDraft[]
      | ((state: RunState) => readonly RunHistoryDraft[]),
    alongside?: Effect.Effect<CoWrite, E, Scope.Scope>,
  ) => Effect.Effect<RunState, RunHistoryRefused | DatabaseWriteFailed | E>;
  /**
   * Re-read the run under the cell's lock: the state with every row another
   * writer committed (a `request.decided` the decide command landed), in
   * commit order, whatever this cell appended since. Folding one such row
   * onto the cell instead cannot work once a sibling call's settlement has
   * committed after it.
   */
  readonly refresh: Effect.Effect<
    RunState,
    RunHistoryRefused | DatabaseReadFailed
  >;
}

/**
 * A `SynchronizedRef`: the loop, the invoker and a barrier call run on one
 * fiber, but a parallel partition settles its calls on sibling fibers, and
 * each settlement must fold onto the one before it.
 */
export const makeRunCell = (
  runId: RunId,
  opened: RunState,
): Effect.Effect<RunCell, never, RunHistory> =>
  Effect.gen(function* () {
    const runHistory = yield* RunHistory;
    const ref = yield* SynchronizedRef.make(opened);
    return {
      runId,
      current: SynchronizedRef.get(ref),
      opened,
      append: (rows, alongside) =>
        SynchronizedRef.updateAndGetEffect(ref, (state) =>
          runHistory.appendBatch(
            runId,
            state,
            typeof rows === 'function' ? rows(state) : rows,
            [],
            alongside,
          ),
        ).pipe(Effect.uninterruptible),
      refresh: SynchronizedRef.updateAndGetEffect(ref, () =>
        Effect.flatMap(runHistory.load(runId), (state) =>
          // The cell opened on rows, so the run has some.
          state === null
            ? Effect.die(new Error(`Run ${runId} lost its rows.`))
            : Effect.succeed(state),
        ),
      ).pipe(Effect.uninterruptible),
    } satisfies RunCell;
  });

/** Why a run the run history holds no rows for cannot be continued. */
const NOT_RESUMABLE_MESSAGE =
  'This run stopped before it recorded any state to resume from. Start a new run instead.';

export type RunEntry =
  /** No opening row yet: the aggregate holds at most queued follow-ups. */
  | { readonly _tag: 'fresh'; readonly opening: RunState }
  | { readonly _tag: 'restored'; readonly loaded: RunState };

/**
 * The run's entry, as data. Takes the claim when resuming, loads the
 * aggregate, and raises both refusals once — a resume with nothing to resume,
 * and a fresh launch onto an aggregate that already holds run history state
 * (#11313). The caller branches on the tag.
 */
export const loadRun = (
  runId: RunId,
  resume: boolean,
): Effect.Effect<RunEntry, Error, RunHistory | AgentRun> =>
  Effect.gen(function* () {
    const runHistory = yield* RunHistory;
    const loaded = resume
      ? yield* runHistory.acquire(runId)
      : yield* runHistory.load(runId);
    if (loaded !== null && loaded.phase !== null) {
      if (!resume) {
        return yield* Effect.fail(
          new Error(
            `Run ${runId} already has run history state; resume it instead.`,
          ),
        );
      }
      return { _tag: 'restored', loaded } satisfies RunEntry;
    }
    // A resume of a run never opened (its launch stopped between its
    // registration and its opening batch) opens it, as the launch would
    // have; its launch context rendered the opening from its configuration.
    const run = yield* AgentRun;
    if (resume && run.opening === null) {
      return yield* Effect.fail(new Error(NOT_RESUMABLE_MESSAGE));
    }
    const bound = yield* SynchronizedRef.get(run.model);
    return {
      _tag: 'fresh',
      // What the opening batch records (`run.config` with its binding): the
      // state its first step is opened on.
      opening: {
        ...freshRunState(0),
        modelId: bound.modelId,
        backend: bound.backend,
        declinedRoutes: run.declinedRoutes,
      },
    } satisfies RunEntry;
  });

/** What a run program, and each of its turns, returns. */
export type RunExit = {
  readonly state: RunState;
  readonly outcome: RunOutcome;
};

/**
 * The one verdict of a failure cause. Any interrupt in it is a stop, even
 * when a finalizer then failed (`Interrupt` + `Die`): the run lifecycle
 * already reports that run `CANCELLED`, so every terminal row agrees.
 */
const failureOutcome = (cause: Cause.Cause<unknown>): RunOutcome =>
  Cause.hasInterrupts(cause) ? RUN_OUTCOME.CANCELLED : RUN_OUTCOME.FAILED;

/**
 * The exit protocol, as the release arm of the run's acquireUseRelease:
 * the run's input lease, where it holds one. The halt is not written here:
 * it commits with the run's `run.end` (`finalizeRun`), so no reader ever
 * sees a stopped run without its end.
 */
export const settleRun =
  (
    cell: RunCell,
    /** The run's own input lease, or null for a run that takes no input. */
    lease: FollowUps | null,
  ) =>
  (exit: Exit.Exit<RunExit, Error>): Effect.Effect<void, never, Runs> => {
    if (lease === null) return Effect.void;
    // The body's own value when it returned.
    const outcome = Exit.match(exit, {
      onSuccess: (value) => value.outcome,
      onFailure: failureOutcome,
    });
    return Effect.gen(function* () {
      const runs = yield* Runs;
      lease.release(
        outcome === RUN_OUTCOME.COMPLETED && !runs.hasActiveChildren(cell.runId)
          ? 'terminal'
          : 'recoverable',
      );
    });
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
    const stopped = ensureError(Cause.squash(cause));
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
              onFailure: failureOutcome,
            }),
          ),
        ),
    );
