/**
 * The terminal a run's launch owns: the backstop `run.end` its lifecycle did
 * not write, the host's final artifacts, the run's ending and the claim. A
 * fresh root (`runAgent`), a standalone resume and a detached child's handoff
 * end through {@link runWithLaunchGuard}; a child loop's own tail writes the
 * same backstop row.
 */
import { Cause, Effect, Exit, FiberSet } from 'effect';

import { finalizeRun } from '@agent/storage/runLifecycle';
import { classifyAgentError } from '@common/errors';
import { getSdkErrorMessage } from '@common/errors/sdkError/providerErrorFormat';
import type { ProcessServices } from '@platform/processRuntime';
import { RUN_OUTCOME, type RunId, type RunOutcome } from '@shared/schemas';
import { aggregateError } from '@utils/core';
import { ensureError } from '@utils/errors/errorMessage';

import type { SessionHandle } from './SessionHandle';

/**
 * The fork every run of a session starts on (`RunRegistry.launch`), made
 * once by the session layer in the session's scope over the session's
 * context. Every Effect fork starts with its parent's context, so a run
 * forked from a tool call read that call's run-scoped services as its own
 * (#13348). A child's link to its parent is data (`parentRunId`), never
 * fiber ancestry.
 */
export const makeRunFork = FiberSet.makeRuntime<ProcessServices>;

/**
 * End a run its lifecycle did not end: the one backstop writer of `run.end`
 * beside the lifecycle's own terminal. An outcome the lifecycle already wrote
 * stands (`keepExistingOutcome`), so a row lands only for a run that failed
 * or stopped before its lifecycle, or outside it; a failure carries its
 * classified error.
 */
export const endRunOutsideLifecycle = (
  session: SessionHandle,
  runId: RunId,
  outcome: RunOutcome,
  error: unknown,
): Effect.Effect<void, Error> =>
  finalizeRun(session, {
    runId,
    outcome,
    keepExistingOutcome: true,
    ...(outcome === RUN_OUTCOME.FAILED && error != null
      ? {
          error: {
            kind: classifyAgentError(error),
            message: getSdkErrorMessage(error),
          },
        }
      : {}),
  }).pipe(
    Effect.flatMap((finalized) =>
      finalized.ok ? Effect.void : Effect.fail(ensureError(finalized.error)),
    ),
  );

/** A launch that owns its run for the run's whole life. */
export interface RunTerminalOwner {
  /** Fires once the launch holds the run's claim. */
  readonly onRunClaimed?: (runId: RunId) => void;
  /**
   * Host-owned final state, persisted before the run's ending commits; true
   * when the hook committed that ending itself (`commitRunEnd`). Its failure
   * is one more failure reported, never a `false`: the ending still commits.
   */
  readonly beforeRunEnd?: (
    session: SessionHandle,
  ) => Effect.Effect<boolean | void, Error>;
}

/**
 * The one terminal of a run's launch, in the exit-protocol pattern: a stop
 * lands before it or after it, never inside. It ends what the lifecycle did
 * not ({@link endRunOutsideLifecycle}: FAILED, or CANCELLED for a stop),
 * persists the host's final artifacts, commits the run's ending, then lets
 * the claim go.
 *
 * With an `owner`, the launch owns the run for its whole life (a fresh root,
 * a standalone resume): the guard holds the run's claim around `operation`
 * and ends the run on every exit once that hold is taken; a refused hold
 * fails as itself. Without one, `operation` only hands an admitted child to
 * its loop, which owns the ending from there: the guard ends the run when the
 * handoff fails and releases the birth claim no driver took.
 *
 * The terminal's failures replace the operation's own as one aggregate; an
 * interruption unwinds as itself.
 */
export function runWithLaunchGuard<A, E, R>(
  session: SessionHandle,
  runId: RunId,
  operation: Effect.Effect<A, E, R>,
  owner?: RunTerminalOwner,
): Effect.Effect<A, E | Error, R> {
  return Effect.suspend(() => {
    const failures: unknown[] = [];
    const collect = <X, Y>(exit: Exit.Exit<X, Y>): void => {
      if (Exit.isFailure(exit)) failures.push(Cause.squash(exit.cause));
    };
    const terminal = (exit: Exit.Exit<A, E>) =>
      Effect.gen(function* () {
        if (Exit.isFailure(exit)) {
          const stopped = Cause.hasInterrupts(exit.cause);
          collect(
            yield* Effect.exit(
              endRunOutsideLifecycle(
                session,
                runId,
                stopped ? RUN_OUTCOME.CANCELLED : RUN_OUTCOME.FAILED,
                Cause.squash(exit.cause),
              ),
            ),
          );
        }
        const artifacts = yield* Effect.exit(
          Effect.suspend(() => owner?.beforeRunEnd?.(session) ?? Effect.void),
        );
        collect(artifacts);
        if (Exit.isFailure(artifacts) || artifacts.value !== true)
          collect(yield* Effect.exit(session.commitRunEnd(runId)));
        // A hold taken and let go at once releases the birth claim no driver
        // took; an owner's own hold is released by its scope.
        if (owner === undefined)
          yield* Effect.scoped(Effect.ignore(session.holdRunClaim(runId)));
      }).pipe(Effect.uninterruptible);
    const guarded: Effect.Effect<A, E | Error, R> =
      owner === undefined
        ? operation.pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : terminal(exit),
            ),
          )
        : Effect.scoped(
            Effect.gen(function* () {
              yield* session.holdRunClaim(runId);
              owner.onRunClaimed?.(runId);
              return yield* operation.pipe(Effect.onExit(terminal));
            }),
          );
    return Effect.exit(guarded).pipe(
      Effect.flatMap((exit) => {
        if (
          failures.length === 0 ||
          (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
        )
          return exit;
        const message = `Run ${runId} failed or its ending could not be persisted`;
        // A stop that carried a defect keeps both; the ending's failures join.
        if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
          return Effect.failCause(
            Cause.combine(
              exit.cause,
              Cause.fail(ensureError(aggregateError(failures, message))),
            ),
          );
        if (Exit.isFailure(exit)) failures.unshift(Cause.squash(exit.cause));
        return Effect.fail(ensureError(aggregateError(failures, message)));
      }),
    );
  });
}
