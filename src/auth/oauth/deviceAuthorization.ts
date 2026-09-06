/**
 * Device-authorization polling as one Effect program, shared by the Codex
 * custom JSON flow, the xAI RFC 8628 flow, and the TeXRA (Supabase) CLI
 * device sign-in.
 *
 * The poll is `Effect.retry` while the endpoint reports "pending", spaced by
 * the server's interval with RFC 8628 `slow_down` growth folded into the
 * schedule. The code's lifetime is a deadline on the runtime clock checked
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

const isPending = (error: unknown): error is DeviceAuthorizationPending =>
  error instanceof DeviceAuthorizationPending;

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
  const increment = options.slowDownIncrementMs ?? 0;

  // A poll never starts past the deadline; one in flight at the deadline
  // completes.
  const guardedPoll = Effect.gen(function* () {
    if (!(yield* beforeDeadline)) return yield* timedOut;
    return yield* options.poll;
  });

  // The server asks the client to wait the interval before its first poll,
  // and the schedule spaces every later one.
  yield* Effect.sleep(Duration.millis(options.intervalMs));
  return yield* guardedPoll.pipe(
    Effect.tapError((error) =>
      isPending(error) && error.slowDown
        ? Ref.update(extraDelayMs, (ms) => ms + increment)
        : Effect.void,
    ),
    Effect.retry({
      // Still pending and the code is still alive: wait once more. The retry
      // stops with the pending failure at the deadline.
      while: (error) => (isPending(error) ? beforeDeadline : false),
      schedule: Schedule.spaced(Duration.millis(options.intervalMs)).pipe(
        Schedule.addDelay(() => Ref.get(extraDelayMs)),
      ),
    }),
    Effect.catchIf(isPending, () => timedOut),
  );
});

/**
 * Persist the approved token as a session through the coordinator's settled
 * store: the Supabase coordinator's store program settled by `runAuthProgram`,
 * or a subscription coordinator's Promise method while that surface settles
 * its own callers. An interruption already pending is honored before the
 * store starts; once it has started, an interruption waits for it, so the
 * persisted session and the caller's view of it never diverge.
 */
export const completeDeviceSession = Effect.fn(
  'deviceAuthorization.completeDeviceSession',
)(function* <Session>(complete: () => Promise<Session>) {
  yield* Effect.yieldNow;
  return yield* Effect.uninterruptible(
    Effect.tryPromise({
      try: complete,
      catch: (cause) =>
        new SessionCompletionFailed({ message: toErrorMessage(cause), cause }),
    }),
  );
});
