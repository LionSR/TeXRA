/**
 * Device-authorization polling as one Effect program, shared by the Codex
 * custom JSON flow, the xAI RFC 8628 flow, and the TeXRA (Supabase) CLI
 * device sign-in.
 *
 * The poll is `Effect.retry` while the endpoint reports "pending", spaced by
 * the server's interval with RFC 8628 `slow_down` growth folded into the
 * schedule. A transient failure (a network blip, a 5xx) is retried too, but
 * only a few times in a row: it is logged at warn each time, and when the
 * budget runs out, or the deadline passes, the poll fails with the transient's
 * own error rather than a timeout. The code's lifetime is a deadline on the runtime clock checked
 * before each wait and before each poll — never during a request, so a poll
 * in flight when the code expires still completes and its authorization is
 * honored. Cancellation is fiber interruption from the host's run edge; there
 * is no signal threading here.
 */
import { Clock, Data, Duration, Effect, Ref, Schedule } from 'effect';

import { toErrorMessage } from '@utils/errors/errorMessage';

/** The user has not approved yet; `slowDown` asks for a longer interval. */
export class DeviceAuthorizationPending extends Data.TaggedError(
  'DeviceAuthorizationPending',
)<{
  readonly slowDown: boolean;
}> {}

/**
 * One poll failed in a way worth retrying. `error` is the failure the poll
 * raises once {@link MAX_CONSECUTIVE_TRANSIENTS} transients in a row have
 * exhausted the budget, or when the code's lifetime ends on one.
 */
export class DeviceAuthorizationTransient<
  Err extends Error = Error,
> extends Data.TaggedError('DeviceAuthorizationTransient')<{
  readonly error: Err;
}> {}

const MAX_CONSECUTIVE_TRANSIENTS = 3;

/** The user code's lifetime elapsed before the user approved. */
export class DeviceCodeTimedOut extends Data.TaggedError('DeviceCodeTimedOut')<{
  readonly message: string;
}> {}

/** The coordinator rejected while persisting the approved session. */
export class SessionCompletionFailed extends Data.TaggedError(
  'SessionCompletionFailed',
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const DEVICE_CODE_TIMED_OUT_MESSAGE =
  'Device-code sign-in timed out. Run sign-in again.';

/** What the poll fails with: the poll's own terminal errors, a transient's
 *  carried error, or the code's expiry. */
type DeviceAuthorizationFailure<E> =
  | Exclude<E, DeviceAuthorizationPending | DeviceAuthorizationTransient>
  | (E extends DeviceAuthorizationTransient<infer Err> ? Err : never)
  | DeviceCodeTimedOut;

const isPending = (error: unknown): error is DeviceAuthorizationPending =>
  error instanceof DeviceAuthorizationPending;

const isTransient = (error: unknown): error is DeviceAuthorizationTransient =>
  error instanceof DeviceAuthorizationTransient;

interface DeviceAuthorizationOptions<Token, E, R> {
  /** One poll of the token endpoint; pending is a typed failure. */
  readonly poll: Effect.Effect<Token, E, R>;
  /** Poll interval in milliseconds, as the server reported it. */
  readonly intervalMs: number;
  /** Lifetime of the user code in milliseconds. */
  readonly expiresInMs: number;
  /** Extra milliseconds added to the interval per `slow_down` (RFC 8628). */
  readonly slowDownIncrementMs?: number;
}

/**
 * Wait the interval and poll; keep polling while the endpoint reports
 * pending; give up when the code's lifetime elapses. Resolves to the approved
 * token.
 */
export const pollDeviceAuthorization = Effect.fn(
  'deviceAuthorization.pollDeviceAuthorization',
)(function* <Token, E, R>(options: DeviceAuthorizationOptions<Token, E, R>) {
  const deadline = (yield* Clock.currentTimeMillis) + options.expiresInMs;
  const beforeDeadline = Effect.map(
    Clock.currentTimeMillis,
    (now) => now < deadline,
  );
  const timedOut = new DeviceCodeTimedOut({
    message: DEVICE_CODE_TIMED_OUT_MESSAGE,
  });
  const extraDelayMs = yield* Ref.make(0);
  // The transients since the last pending answer, and the latest of them.
  const transients = yield* Ref.make<{
    readonly count: number;
    readonly last: DeviceAuthorizationTransient | undefined;
  }>({ count: 0, last: undefined });
  const increment = options.slowDownIncrementMs ?? 0;

  // A poll never starts past the deadline; one in flight at the deadline
  // completes. A code that expires while the endpoint was failing reports
  // that failure, not a timeout.
  const guardedPoll = Effect.gen(function* () {
    if (!(yield* beforeDeadline)) {
      const { last } = yield* Ref.get(transients);
      return yield* last === undefined ? timedOut : Effect.fail(last.error);
    }
    return yield* options.poll;
  });

  // The server asks the client to wait the interval before its first poll,
  // and the schedule spaces every later one.
  yield* Effect.sleep(Duration.millis(options.intervalMs));
  return yield* guardedPoll.pipe(
    Effect.tapError((error) => {
      if (isPending(error)) {
        return Ref.set(transients, { count: 0, last: undefined }).pipe(
          Effect.andThen(
            error.slowDown
              ? Ref.update(extraDelayMs, (ms) => ms + increment)
              : Effect.void,
          ),
        );
      }
      if (isTransient(error)) {
        return Ref.update(transients, ({ count }) => ({
          count: count + 1,
          last: error,
        })).pipe(
          Effect.andThen(
            Effect.logWarning(
              `Device authorization poll failed (transient): ${error.error.message}`,
            ),
          ),
        );
      }
      return Effect.void;
    }),
    Effect.retry({
      // Still pending and the code is still alive: wait once more. A
      // transient also waits once more while the consecutive budget lasts.
      // The retry stops with the pending or transient failure at the deadline.
      while: (error) => {
        if (isPending(error)) return beforeDeadline;
        if (!isTransient(error)) return false;
        return Effect.flatMap(Ref.get(transients), ({ count }) =>
          count < MAX_CONSECUTIVE_TRANSIENTS
            ? beforeDeadline
            : Effect.succeed(false),
        );
      },
      schedule: Schedule.spaced(Duration.millis(options.intervalMs)).pipe(
        Schedule.addDelay(() => Ref.get(extraDelayMs)),
      ),
    }),
    // A pending at the deadline is a timeout; a transient, whether its budget
    // ran out or the deadline passed, is its own carried failure.
    Effect.mapError((error) => {
      if (isPending(error)) return timedOut;
      return (
        isTransient(error) ? error.error : error
      ) as DeviceAuthorizationFailure<E>;
    }),
  );
});

/**
 * Persist the approved token as a session through the coordinator's store
 * program. An interruption already pending is honored before the store
 * starts; once it has started, an interruption waits for it, so the persisted
 * session and the caller's view of it never diverge.
 */
export const completeDeviceSession = Effect.fn(
  'deviceAuthorization.completeDeviceSession',
)(function* <Session, E, R>(complete: () => Effect.Effect<Session, E, R>) {
  yield* Effect.yieldNow;
  return yield* Effect.uninterruptible(
    complete().pipe(
      Effect.mapError(
        (cause) =>
          new SessionCompletionFailed({
            message: toErrorMessage(cause),
            cause,
          }),
      ),
    ),
  );
});
