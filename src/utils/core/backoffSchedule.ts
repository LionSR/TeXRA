/**
 * The one `[1, 2)` randomized exponential backoff `Schedule`: retry `n`
 * (1-based) waits `base * 2^(n-1)`, scaled by a uniform factor in [1, 2).
 *
 * It is the window every HTTP retry in the repo was tuned to under p-retry's
 * `randomize: true` — the tool fetch retry in `@tools/timeouts` and the arXiv
 * source download — and it is deliberately not `Schedule.jittered`, which
 * scales by [0.8, 1.2] instead and would cut the mean wait before a 429/5xx
 * retry by a third.
 *
 * `jitteredExponentialBackoffMs` in `@utils/core` is a different contract —
 * symmetric ±20 % jitter under a cap, returned as a number to a caller that
 * sleeps for itself (`ModelRetryGate`, GitHub polling) — and stays there.
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
