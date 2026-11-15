import { Effect } from 'effect';

/**
 * Recover a **typed** failure of an optional step: `report` logs it, then
 * `recover` produces the fallback, so the fallback is loud by construction,
 * never silent. The report is the caller's, which keeps each site's own
 * level, message and diagnostic payload.
 *
 * Defects and interruption deliberately pass straight through: a bug is not
 * a recoverable failure, and a cancelled run is not a skipped step.
 */
export const recoverLogged =
  <E, T, R2 = never>(
    report: (error: E) => void,
    recover: (error: E) => Effect.Effect<T, never, R2>,
  ) =>
  <A, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | T, never, R | R2> =>
    Effect.catch(effect, (error) =>
      Effect.suspend(() => {
        report(error);
        return recover(error);
      }),
    );
