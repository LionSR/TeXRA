/**
 * The two recovery tails the run and session pipelines repeat.
 *
 * `warnAndSwallow` is the best-effort catch handler: a step whose failure must
 * not change the run's outcome is logged on its channel and the pipeline
 * continues — loud, per the "silent degradation is a defect" rule, but not
 * fatal. `squashFailures` is the other half of the same story: a teardown that
 * ran every step under `Effect.exit` so one failure could not cost the others
 * reduces those exits to the errors it has to report together.
 */
// Third-party imports
import { Cause, Effect, Exit } from 'effect';

/**
 * The one method {@link warnAndSwallow} needs from a channel logger. Both
 * `@logger/logUtils`' `Log` and an `AgentTrace` satisfy it, so a helper path
 * and a run path share the handler.
 */
interface WarnLogger {
  warn(message: string, options: { readonly data?: unknown }): void;
}

/**
 * Build the catch handler for work whose failure is reportable but not fatal:
 * `step.pipe(Effect.catch(warnAndSwallow(logger, 'Step failed')))` logs the
 * error as `{ data: error }` and continues with `void`. Pass `context` when
 * the entry names what failed too, which logs `{ data: { ...context, error } }`.
 */
export const warnAndSwallow =
  (logger: WarnLogger, message: string, context?: Record<string, unknown>) =>
  (error: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      logger.warn(message, {
        data: context === undefined ? error : { ...context, error },
      });
    });

/**
 * The squashed error of every failed exit, in the order the steps settled;
 * successes contribute nothing. Feed the result to `aggregateError` to report
 * a teardown's independent failures as one.
 */
export const squashFailures = (
  exits: readonly Exit.Exit<unknown, unknown>[],
): unknown[] =>
  exits.flatMap((exit) =>
    Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
  );
