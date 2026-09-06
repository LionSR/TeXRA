// Device-code (RFC 8628 style) sign-in client for the TeXRA CLI.
//
// Protocol layer only: request a device authorization from the auth-device
// edge function, then poll its token endpoint until the user approves the
// code from a browser on any device. Session storage lives with the other
// sign-in flows in `supabaseAuth.ts`.
//
// Both steps are Effect programs: each request runs under
// `withRequestTimeout`, the poll is `Effect.retry` while the endpoint
// reports "pending", spaced by the server's interval with RFC 8628
// `slow_down` growth folded into the schedule, and the code's lifetime is a
// deadline on the runtime clock. Cancellation is fiber interruption from the
// command's run edge; there is no signal threading here.

// Third-party imports
import { Clock, Data, Duration, Effect, Ref, Schedule } from 'effect';
import { z } from 'zod';

// Local imports - auth
import { DEVICE_AUTH_BASE_URL } from '@auth/config';
import {
  parseTokenExchangeResponse,
  type GitHubTokenExchangeResponse,
} from '@auth/SupabaseSession';
import { withRequestTimeout } from '@tools/timeouts';
import { toErrorMessage } from '@utils/errors/errorMessage';

const DEVICE_AUTH_REQUEST_TIMEOUT_MS = 30000;

/** Extra milliseconds added to the poll interval on an RFC 8628 slow_down. */
const SLOW_DOWN_INCREMENT_MS = 5000;

/** Consecutive transient poll failures tolerated before giving up. */
const MAX_TRANSIENT_POLL_FAILURES = 3;

export const DeviceAuthorizationSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().catch(5),
});
export type DeviceAuthorization = z.infer<typeof DeviceAuthorizationSchema>;

/** Every way the device sign-in fails; `message` is what the user reads. */
export class DeviceSignInError extends Data.TaggedError('DeviceSignInError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The user has not approved yet; `slowDown` asks for a longer interval. */
class DeviceAuthorizationPending extends Data.TaggedError(
  'DeviceAuthorizationPending',
)<{
  readonly slowDown: boolean;
}> {}

interface DeviceAuthHooks {
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the device auth edge function URL. */
  readonly baseUrl?: string;
}

export const CLI_DEVICE_AUTH_URL_PROMPT =
  'On any device, open this URL in a browser:';

export function formatCliDeviceAuthMessage(
  authorization: Pick<DeviceAuthorization, 'user_code' | 'verification_uri'>,
): string {
  return [
    CLI_DEVICE_AUTH_URL_PROMPT,
    authorization.verification_uri,
    `and enter this code: ${authorization.user_code}`,
  ].join('\n');
}

/** One POST against the device-auth edge function, headers under the deadline. */
const postDeviceAuth = Effect.fn('supabaseAuthDeviceCode.postDeviceAuth')(
  (hooks: DeviceAuthHooks, path: string, body?: object) =>
    withRequestTimeout(DEVICE_AUTH_REQUEST_TIMEOUT_MS, (signal) =>
      (hooks.fetchImpl ?? fetch)(
        `${hooks.baseUrl ?? DEVICE_AUTH_BASE_URL}${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(body && { body: JSON.stringify(body) }),
          signal,
        },
      ),
    ),
);

/** Start a device authorization with the auth server. */
export const requestDeviceAuthorization = Effect.fn(
  'supabaseAuthDeviceCode.requestDeviceAuthorization',
)(function* (hooks: DeviceAuthHooks = {}) {
  const response = yield* postDeviceAuth(hooks, '/code').pipe(
    Effect.mapError(
      (error) =>
        new DeviceSignInError({
          message:
            error._tag === 'RequestTimedOut'
              ? 'Device sign-in request timed out'
              : error.message,
          cause: error,
        }),
    ),
  );
  if (!response.ok) {
    return yield* new DeviceSignInError({
      message: `Device sign-in is unavailable right now (HTTP ${response.status}). Try again, or use \`texra login --no-browser\`.`,
    });
  }
  const parsed = DeviceAuthorizationSchema.safeParse(
    yield* Effect.promise(() => response.json().catch(() => null)),
  );
  if (!parsed.success) {
    return yield* new DeviceSignInError({
      message: 'Device sign-in returned an unexpected response.',
    });
  }
  return parsed.data;
});

/**
 * Poll the token endpoint until the device code is approved, honoring the
 * RFC 8628 `interval`, `slow_down`, `authorization_pending`, `access_denied`,
 * and `expired_token` semantics. Waits the interval before each poll, the
 * first included, and gives up once the code's lifetime elapses (checked
 * after each wait, before the request — the historical CLI timing).
 */
export const pollForDeviceSession = Effect.fn(
  'supabaseAuthDeviceCode.pollForDeviceSession',
)(function* (
  authorization: Pick<
    DeviceAuthorization,
    'device_code' | 'expires_in' | 'interval'
  >,
  hooks: DeviceAuthHooks = {},
) {
  const intervalMs = authorization.interval * 1000;
  const deadline =
    (yield* Clock.currentTimeMillis) + authorization.expires_in * 1000;
  const transientFailures = yield* Ref.make(0);
  const extraDelayMs = yield* Ref.make(0);

  /** Count one transient failure; fail once too many land in a row. */
  const tolerate = (
    failure: () => DeviceSignInError,
  ): Effect.Effect<never, DeviceSignInError | DeviceAuthorizationPending> =>
    Effect.flatMap(
      Ref.updateAndGet(transientFailures, (count) => count + 1),
      (count) =>
        Effect.fail(
          count >= MAX_TRANSIENT_POLL_FAILURES
            ? failure()
            : new DeviceAuthorizationPending({ slowDown: false }),
        ),
    );

  const attempt = Effect.gen(function* () {
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return yield* deviceCodeExpiredError();
    }
    const response = yield* postDeviceAuth(hooks, '/token', {
      device_code: authorization.device_code,
    }).pipe(
      // Headless/SSH connections blip; tolerate a few in a row before failing.
      Effect.catch((error) =>
        tolerate(
          () =>
            new DeviceSignInError({
              message:
                error._tag === 'RequestTimedOut'
                  ? 'Device sign-in poll timed out'
                  : error.message,
              cause: error,
            }),
        ),
      ),
    );

    if (response.ok) {
      return yield* Effect.tryPromise({
        try: () => parseTokenExchangeResponse(response),
        catch: (cause) =>
          new DeviceSignInError({ message: toErrorMessage(cause), cause }),
      });
    }

    const errorCode = yield* Effect.promise(() =>
      readDeviceErrorCode(response),
    );
    switch (errorCode) {
      case 'authorization_pending':
        yield* Ref.set(transientFailures, 0);
        return yield* new DeviceAuthorizationPending({ slowDown: false });
      case 'slow_down':
        yield* Ref.set(transientFailures, 0);
        return yield* new DeviceAuthorizationPending({ slowDown: true });
      case 'expired_token':
        return yield* deviceCodeExpiredError();
      case 'access_denied':
        return yield* new DeviceSignInError({
          message: 'Sign-in was denied in the browser.',
        });
      default:
        if (response.status === 429 || response.status >= 500) {
          return yield* tolerate(
            () =>
              new DeviceSignInError({
                message: `Device sign-in failed (HTTP ${response.status}). Try again.`,
              }),
          );
        }
        return yield* new DeviceSignInError({
          message: `Device sign-in failed: ${errorCode ?? `HTTP ${response.status}`}`,
        });
    }
  });

  // The server asks the client to wait the interval before its first poll,
  // and the schedule spaces every later one.
  yield* Effect.sleep(Duration.millis(intervalMs));
  return yield* attempt.pipe(
    Effect.tapError((error) =>
      error._tag === 'DeviceAuthorizationPending' && error.slowDown
        ? Ref.update(extraDelayMs, (ms) => ms + SLOW_DOWN_INCREMENT_MS)
        : Effect.void,
    ),
    Effect.retry({
      while: (error): error is DeviceAuthorizationPending =>
        error._tag === 'DeviceAuthorizationPending',
      schedule: Schedule.spaced(Duration.millis(intervalMs)).pipe(
        Schedule.addDelay(() => Ref.get(extraDelayMs)),
      ),
    }),
  );
});

function deviceCodeExpiredError(): DeviceSignInError {
  return new DeviceSignInError({
    message:
      'The sign-in code expired before it was approved. Run the sign-in again to get a fresh code.',
  });
}

async function readDeviceErrorCode(
  response: Response,
): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' ? error : undefined;
}
