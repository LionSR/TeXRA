// Third-party imports
import { PlatformError, Schedule } from 'effect';

/**
 * Restart schedule for an `fs.watch` stream: up to 5 retries, 1 s doubling,
 * and only for `Unknown` platform errors (a missing or denied directory will
 * not fix itself, so those end the stream).
 */
export const fileWatchRetrySchedule = Schedule.exponential('1 second').pipe(
  Schedule.upTo({ times: 5 }),
  Schedule.while(
    ({ input }: { readonly input: PlatformError.PlatformError }) =>
      input.reason._tag === 'Unknown',
  ),
);
