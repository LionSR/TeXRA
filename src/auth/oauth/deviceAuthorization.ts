/**
 * Device-authorization polling as one Effect program (Codex custom JSON and
 * xAI RFC 8628 share it; the Supabase CLI flow still runs the Promise twin in
 * `deviceCodePoll.ts` until its lane converts).
 *
 * The poll is `Effect.retry` while the endpoint reports "pending", spaced by
 * the server's interval with RFC 8628 `slow_down` growth folded into the
 * schedule, and bounded by the code's lifetime through `Effect.timeoutOrElse`.
 * Cancellation is fiber interruption from the flow's Promise edge; there is
 * no signal threading here.
 */
import { Data, Duration, Effect, Ref, Schedule } from 'effect';

import type { ProviderAuthErrorCtor } from './providerAuthBridge';
import type {
  OAuthHttpError,
  OAuthNetworkError,
  OAuthUnexpectedResponse,
} from './oauthRequest';

/** The user has not approved yet; `slowDown` asks for a longer interval. */
export class DeviceAuthorizationPending extends Data.TaggedError(
  'DeviceAuthorizationPending',
)<{
  readonly slowDown: boolean;
}> {}

/** The user code's lifetime elapsed before the user approved. */
class DeviceCodeTimedOut extends Data.TaggedError('DeviceCodeTimedOut')<{
  readonly message: string;
}> {}

/** The coordinator rejected while persisting the approved session. */
class SessionCompletionFailed extends Data.TaggedError(
  'SessionCompletionFailed',
)<{
  readonly cause: unknown;
}> {}

const DEVICE_CODE_TIMED_OUT_MESSAGE =
  'Device-code sign-in timed out. Run sign-in again.';

interface DeviceAuthorizationOptions<Token, Session, E, R> {
  /** One poll of the token endpoint; pending is a typed failure. */
  readonly poll: Effect.Effect<Token, E, R>;
  /** Persist the approved token as a session (a Promise coordinator method). */
  readonly complete: (token: Token) => Promise<Session>;
  /** Poll interval in milliseconds, as the server reported it. */
  readonly intervalMs: number;
  /** Lifetime of the user code in milliseconds. */
  readonly expiresInMs: number;
  /** Extra milliseconds added to the interval per `slow_down` (RFC 8628). */
  readonly slowDownIncrementMs?: number;
}

/**
 * Wait the interval, poll, and persist once approved; keep polling while the
 * endpoint reports pending; give up when the code's lifetime elapses.
 */
export const pollDeviceAuthorization = Effect.fn(
  'deviceAuthorization.pollDeviceAuthorization',
)(function* <Token, Session, E, R>(
  options: DeviceAuthorizationOptions<Token, Session, E, R>,
) {
  const extraDelayMs = yield* Ref.make(0);
  const increment = options.slowDownIncrementMs ?? 0;
  const isPending = (error: unknown): boolean =>
    error instanceof DeviceAuthorizationPending;

  const attempt = Effect.gen(function* () {
    const token = yield* options.poll.pipe(
      Effect.tapError((error) =>
        error instanceof DeviceAuthorizationPending && error.slowDown
          ? Ref.update(extraDelayMs, (ms) => ms + increment)
          : Effect.void,
      ),
    );
    return yield* Effect.tryPromise({
      try: () => options.complete(token),
      catch: (cause) => new SessionCompletionFailed({ cause }),
    });
  });

  return yield* Effect.gen(function* () {
    // The server asks the client to wait the interval before its first poll,
    // and the schedule spaces every later one.
    yield* Effect.sleep(Duration.millis(options.intervalMs));
    return yield* attempt.pipe(
      Effect.retry({
        while: isPending,
        schedule: Schedule.spaced(Duration.millis(options.intervalMs)).pipe(
          Schedule.addDelay(() => Ref.get(extraDelayMs)),
        ),
      }),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(options.expiresInMs),
      orElse: () =>
        Effect.fail(
          new DeviceCodeTimedOut({ message: DEVICE_CODE_TIMED_OUT_MESSAGE }),
        ),
    }),
  );
});

/** Every expected failure the shared request and poll programs can raise. */
export type DeviceAuthorizationError =
  | OAuthNetworkError
  | OAuthHttpError
  | OAuthUnexpectedResponse
  | DeviceAuthorizationPending
  | DeviceCodeTimedOut
  | SessionCompletionFailed;

/**
 * Re-mint a shared failure as what the flow's Promise API always threw: the
 * provider's auth error with the same message, kind, and status; a plain
 * `Error` for the timeout; the coordinator's own rejection untouched.
 */
export function deviceAuthorizationThrowable(
  error: DeviceAuthorizationError,
  ErrorType: ProviderAuthErrorCtor,
): unknown {
  switch (error._tag) {
    case 'OAuthNetworkError':
      return new ErrorType(error.message, 'transient', undefined, {
        cause: error.cause,
      });
    case 'OAuthHttpError':
      return new ErrorType(error.message, error.kind, error.status);
    case 'OAuthUnexpectedResponse':
      return new ErrorType(error.message, 'transient', undefined, {
        cause: error.cause,
      });
    case 'DeviceAuthorizationPending':
      return new ErrorType('Authorization pending', 'pending');
    case 'DeviceCodeTimedOut':
      return new Error(error.message);
    case 'SessionCompletionFailed':
      return error.cause;
  }
}
