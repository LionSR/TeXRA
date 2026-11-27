/**
 * Device-authorization polling as one Effect program, run by the xAI
 * RFC 8628 grant.
 *
 * The poll is `Effect.retry` while the endpoint reports "pending", spaced by
 * the server's interval with RFC 8628 `slow_down` growth applied to the
 * schedule. A transient failure (a network blip, a 5xx) is retried too, but
 * only a few times in a row: it is logged at warn each time, and when the
 * budget runs out, or the deadline passes, the poll fails with the transient's
 * own error. The schedule caps waits at the code's deadline, and each poll
 * checks the clock before starting. A request already in flight can still
 * complete after expiry. Cancellation is fiber interruption from the host.
 */
import { Cause, Clock, Duration, Effect, Schedule, Schema } from 'effect';

import { SubscriptionOAuthError } from './subscriptionOAuthError.js';

/** The device-code prompt a host renders while polling for approval. */
export interface SubscriptionDeviceCodePrompt {
  /** The one-time code the user types at the verification URL. */
  readonly userCode: string;
  /** Where the user enters the code. */
  readonly verificationUrl: string;
  /** Prefilled verification URL when the provider supplies one (xAI). */
  readonly verificationUrlComplete?: string;
}

/** The user has not approved yet; `slowDown` asks for a longer interval. */
export class DeviceAuthorizationPending extends Schema.TaggedError<DeviceAuthorizationPending>()(
  'DeviceAuthorizationPending',
  { slowDown: Schema.Boolean },
) {}

/**
 * One poll failed in a way worth retrying. `error` is the failure the poll
 * raises once {@link MAX_CONSECUTIVE_TRANSIENTS} transients in a row have
 * exhausted the budget, or when the code's lifetime ends on one.
 */
export class DeviceAuthorizationTransient extends Schema.TaggedError<DeviceAuthorizationTransient>()(
  'DeviceAuthorizationTransient',
  { error: Schema.instanceOf(Error) },
) {}

const MAX_CONSECUTIVE_TRANSIENTS = 3;

const DEVICE_CODE_TIMED_OUT_MESSAGE =
  'Device-code sign-in timed out. Run sign-in again.';

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
  readonly slowDownIncrementMs: number;
}

/**
 * Wait the interval and poll; keep polling while the endpoint reports
 * pending; give up when the code's lifetime elapses. Resolves to the approved
 * token.
 */
export const pollDeviceAuthorization = Effect.fn(
  'deviceAuthorization.pollDeviceAuthorization',
)(function* <Token, E, R>(options: DeviceAuthorizationOptions<Token, E, R>) {
  // The code's lifetime elapsed before the user approved: only a fresh
  // sign-in can help.
  const timedOut = new SubscriptionOAuthError({
    message: DEVICE_CODE_TIMED_OUT_MESSAGE,
    kind: 'expired',
  });
  const deadline = (yield* Clock.currentTimeMillis) + options.expiresInMs;
  const schedule = Schedule.fromStep(
    Effect.sync(() => {
      let intervalMs = options.intervalMs;
      let transients = 0;
      return Effect.fnUntraced(function* (
        now: number,
        error: unknown,
      ): Effect.fn.Return<[void, Duration.Duration], Cause.Done> {
        if (isPending(error)) {
          transients = 0;
          if (error.slowDown) intervalMs += options.slowDownIncrementMs;
        } else if (isTransient(error)) {
          transients += 1;
          yield* Effect.logWarning(
            `Device authorization poll failed (transient): ${error.error.message}`,
          );
          if (transients >= MAX_CONSECUTIVE_TRANSIENTS)
            return yield* Cause.done();
        } else {
          return yield* Cause.done();
        }

        const remaining = deadline - now;
        if (remaining <= 0) return yield* Cause.done();
        return [undefined, Duration.millis(Math.min(intervalMs, remaining))];
      });
    }),
  );

  yield* Effect.sleep(Math.min(options.intervalMs, options.expiresInMs));
  return yield* Effect.gen(function* () {
    if ((yield* Clock.currentTimeMillis) < deadline) return yield* options.poll;
    // A wait can end at expiry. Preserve the previous network failure if
    // it was the last answer the endpoint gave us.
    const { input } = yield* Schedule.CurrentMetadata;
    return yield* Effect.fail(isTransient(input) ? input.error : timedOut);
  }).pipe(
    Effect.retry(schedule),
    Effect.mapError((error) => {
      if (isPending(error)) return timedOut;
      return isTransient(error) ? error.error : error;
    }),
  );
});
