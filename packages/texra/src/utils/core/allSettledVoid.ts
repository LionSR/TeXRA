// Third-party imports
import { Effect, Exit } from 'effect';

/**
 * `Promise.all` semantics for a fan-out of side-effecting programs: every one
 * runs to completion even when another fails, and the first failure is the
 * result. Both settings views fan out repaints this way, and a half-repainted
 * view is not an improvement on a failed one.
 *
 * `Effect.all` is not this: its default interrupts a failed program's
 * siblings, and `mode: "result"` captures only the error channel (a defect
 * still fails the call and takes the siblings with it) and never re-raises.
 * Collecting exits keeps the whole cause, defects and interrupts included.
 */
export function allSettledVoid<E, R>(
  programs: readonly Effect.Effect<void, E, R>[],
): Effect.Effect<void, E, R> {
  return Effect.flatMap(
    Effect.all(programs.map(Effect.exit), { concurrency: 'unbounded' }),
    (exits) => {
      const failed = exits.find(Exit.isFailure);
      return failed ? Effect.failCause(failed.cause) : Effect.void;
    },
  );
}
