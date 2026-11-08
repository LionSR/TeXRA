/**
 * The one `[1, 2)` randomized exponential backoff `Schedule`: retry `n`
 * (1-based) waits `base * 2^(n-1)`, scaled by a uniform factor in [1, 2).
 *
 * It is the window the HTTP retries (tool fetches, file downloads) were
 * tuned to under p-retry's `randomize: true`, and it is deliberately not
 * `Schedule.jittered`, which scales by [0.8, 1.2] instead and would cut the
 * mean wait before a 429/5xx retry by a third.
 *
 * {@link jitteredExponentialBackoffMs} is a different contract: symmetric ±20 %
 * jitter under a cap, returned as a number to a caller that sleeps for
 * itself (`ModelRetryGate`, polling loops).
 */
import { Duration, Effect, Random, Schedule } from 'effect';

export function randomizedExponentialBackoff(base: Duration.Input) {
  return Schedule.exponential(base).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.map(Random.next, (random) =>
        Duration.millis(Duration.toMillis(duration) * (1 + random)),
      ),
    ),
  );
}

const JITTER_FRACTION = 0.2;

/**
 * Compute a jittered exponential backoff delay: `baseMs * 2^(failures-1)`,
 * capped at `maxMs`, then randomized by +/-20% and capped again
 * so jitter can never push the result past `maxMs`. Shared by every retry/
 * backoff loop in the codebase so the jitter formula only exists once.
 *
 * `unitRandom` is the caller's uniform draw in [0, 1) — `yield* Random.next`
 * in the Effect callers — so a test fixes the jitter through Effect's
 * `Random` reference instead of stubbing the global `Math.random`.
 */
export function jitteredExponentialBackoffMs(
  baseMs: number,
  failures: number,
  maxMs: number,
  unitRandom: number,
): number {
  const exponential = Math.min(
    maxMs,
    Math.max(0, baseMs) * 2 ** Math.max(0, failures - 1),
  );
  const jitter = 1 - JITTER_FRACTION + unitRandom * 2 * JITTER_FRACTION;
  return Math.min(maxMs, Math.round(exponential * jitter));
}
