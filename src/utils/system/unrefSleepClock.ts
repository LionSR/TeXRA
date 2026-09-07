import { Clock, Duration, Effect } from 'effect';

/**
 * Wraps an `Effect` `Clock` so its `sleep` schedules an unref'd timer.
 *
 * A background polling or scheduling loop must never keep a host process
 * alive on its own — an unref'd timer lets the process exit while the loop
 * is mid-sleep. Every other clock reading (time, monotonic time) passes
 * through unchanged; only `sleep` differs.
 */
export function unrefSleepClock(clock: Clock.Clock): Clock.Clock {
  return {
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    currentTimeNanos: clock.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const handle = setTimeout(
          () => resume(Effect.void),
          Duration.toMillis(duration),
        );
        handle.unref?.();
        return Effect.sync(() => clearTimeout(handle));
      }),
  };
}
