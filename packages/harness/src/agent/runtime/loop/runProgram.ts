/**
 * The run program's scaffolding: the run's entry, which opens its one cell,
 * and the exit protocol every run settles. What the loop does between them
 * stays in `toolUse.ts`. There is no hook record: the surface is values and
 * total functions, and the loop writes its own three-argument
 * `Effect.acquireUseRelease` (the run-loop design,
 * .agents/docs/implemented/architecture/2026-09-21-effect-design-run-loop-programs.md).
 */

import { Cause, Effect, Exit } from 'effect';

import { activationRows } from '@agent/storage/runLifecycle';
import type { AgentTrace, StageHandle } from '@agent/trace';
import { RUN_OUTCOME, type RunId, type RunOutcome } from '@shared/schemas';
import { RunHistory, type RunCell } from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runStateFold';
import { ensureError } from '@utils/errors/errorMessage';

import { AgentRun } from '../run/AgentRun';
import { Runs } from '../runRegistry';
import type { FollowUps } from '../FollowUps';

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
export const openRun = (
  runId: RunId,
  resume: boolean,
): Effect.Effect<RunCell, Error, RunHistory | AgentRun> =>
  Effect.gen(function* () {
    const runHistory = yield* RunHistory;
    const run = yield* AgentRun;
    const cell = yield* runHistory.open(
      runId,
      resume
        ? {
            activation: (state: RunState | null) =>
              state?.phase == null
                ? Effect.fail(new Error(NOT_RESUMABLE_MESSAGE))
                : activationRows(run.session, runId, run.config),
          }
        : { registration: run.entry.registration ?? [] },
    );
    // A resume has entered its run once its activation committed; a fresh
    // run enters with its opening batch.
    if (resume) yield* run.entry.entered;
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
