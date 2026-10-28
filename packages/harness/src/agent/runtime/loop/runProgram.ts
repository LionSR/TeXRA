/**
 * The run program's scaffolding: the run's entry, which opens its one cell,
 * and the exit protocol every run settles. What the loop does between them
 * stays in `toolUse.ts`. There is no hook record: the surface is values and
 * total functions, and the loop writes its own three-argument
 * `Effect.acquireUseRelease`.
 */

import { Cause, Effect, Exit, SubscriptionRef } from 'effect';

import { activationRows } from '@agent/storage/runLifecycle';
import type { AgentTrace, StageHandle } from '@agent/trace';
import { grantsKept, NO_APPROVAL_GRANTS } from '@shared/approvalBypassKind';
import {
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
  type SessionEventDraft,
} from '@shared/schemas';
import { outcomeFromCause } from '@shared/runs/runStatus';
import { RunHistory, type RunCell } from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runState';
import { ensureError } from '@utils/errors/errorMessage';

import { AgentRun, type AgentRunShape } from '../run/AgentRun';
import { registryOf, Runs } from '../runRegistry';
import type { FollowUps } from '../FollowUps';

/**
 * A fresh run's registration as its birth job decides it. A child a
 * detaching stop cut before it was born (marked once that detach commits,
 * before this job runs, and read here through `RunRegistry.parentOf`) is
 * born detached: no parent, and the grants a detach keeps, inherited from
 * that parent.
 */
const birthRows = (
  run: Pick<AgentRunShape, 'runId' | 'session' | 'entry'>,
): readonly SessionEventDraft[] => {
  const rows = run.entry.registration ?? [];
  const start = rows[0];
  if (
    start?.type !== 'run.start' ||
    start.parent === null ||
    registryOf(run.session.runs).parentOf(run.runId) !== null
  )
    return rows;
  const snapshot = grantsKept(
    SubscriptionRef.getUnsafe(run.session.view.ref),
    run.runId,
    start.parent.id,
    start.approvalPolicy ?? NO_APPROVAL_GRANTS,
  );
  return [
    { ...start, parent: null },
    ...rows.slice(1),
    { type: 'approval.policy', aggregateId: start.aggregateId, snapshot },
  ];
};

/** Why a run its rows never opened cannot be continued. */
const NOT_RESUMABLE_MESSAGE =
  'This run stopped before it recorded any state to resume from. Start a new run instead.';

/**
 * The run's entry: its cell. A fresh run's registration rides the cell's
 * first append, its opening, so the run exists with its opening or not at
 * all. A resume takes the claim and commits its activation, in one batch,
 * and is refused when the rows hold nothing to continue from. A fresh
 * launch onto a run that already holds history state is refused (#11313).
 * The caller opens a cell whose state has no phase.
 */
export const openRun = Effect.fn('runProgram.openRun')(function* (
  runId: RunId,
  resume: boolean,
): Effect.fn.Return<RunCell, Error, RunHistory | AgentRun> {
  const runHistory = yield* RunHistory;
  const run = yield* AgentRun;
  const cell = yield* runHistory
    .open(
      runId,
      resume
        ? {
            activation: (state: RunState | null) =>
              state?.phase == null
                ? Effect.fail(new Error(NOT_RESUMABLE_MESSAGE))
                : activationRows(run.session, runId, run.config),
          }
        : { registration: Effect.sync(() => birthRows(run)) },
    )
    .pipe(
      // A resume enters once its activation settled (a fresh run, with its
      // opening batch); a stop lands before both or after both.
      Effect.tap(() => (resume ? run.entry.entered : Effect.void)),
      Effect.uninterruptible,
    );
  if (!resume && (yield* cell.current).phase !== null)
    return yield* Effect.fail(
      new Error(
        `Run ${runId} already has run history state; resume it instead.`,
      ),
    );
  return cell;
});

/** What a run program, and each of its turns, returns. */
export type RunExit = {
  readonly state: RunState;
  readonly outcome: RunOutcome;
};

/**
 * The exit protocol, as the release arm of the run's acquireUseRelease:
 * the run's input lease, where it holds one. The halt is not written here:
 * it commits with the run's `run.end` (`finalizeRun`), so no reader ever
 * sees a stopped run without its end.
 */
export const settleRun =
  (
    cell: RunCell,
    /** The run's own input lease. */
    lease: FollowUps,
  ) =>
  (exit: Exit.Exit<RunExit, Error>): Effect.Effect<void, never, Runs> => {
    // The body's own value when it returned.
    const outcome = Exit.match(exit, {
      onSuccess: (value) => value.outcome,
      onFailure: outcomeFromCause,
    });
    return Effect.gen(function* () {
      const runs = registryOf(yield* Runs);
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
 * the body's value, which is why a stage closed from a mutable verdict was the
 * older shape. This serves the run loop, whose stage closes with its body;
 * `childRunLoop` deliberately keeps a mutable `stage` field, because a detached
 * or process child's stage outlives the body and closes on the settlement a
 * surviving fiber delivers, so it cannot be expressed as acquireUseRelease.
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
              onFailure: outcomeFromCause,
            }),
          ),
        ),
    );
