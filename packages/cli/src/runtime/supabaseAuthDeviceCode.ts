// Device-code (RFC 8628 style) sign-in client for the TeXRA CLI.
//
// Protocol layer only: request a device authorization from the auth-device
// edge function, then poll its token endpoint until the user approves the
// code from a browser on any device. Both are Effect programs over the shared
// OAuth request and device-authorization poll; session storage lives with the
// other sign-in flows in `supabaseAuth.ts`.

// Third-party imports
import { Data, Effect, Ref } from 'effect';
import { z } from 'zod';

// Local imports - auth
import { DEVICE_AUTH_BASE_URL } from '@auth/config';
import { GitHubTokenExchangeSchema } from '@auth/SupabaseSession';
import {
  DeviceAuthorizationPending,
  pollDeviceAuthorization,
} from '@auth/oauth/deviceAuthorization';
import { parseOAuthJson, postOAuth } from '@auth/oauth/oauthRequest';
import { isObject } from '@utils/core';

const DEVICE_AUTH_REQUEST_TIMEOUT_MS = 30000;

/** Extra seconds added to the poll interval on an RFC 8628 slow_down. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** Consecutive transient poll failures tolerated before giving up. */
const MAX_TRANSIENT_POLL_FAILURES = 3;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const DeviceAuthorizationSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().catch(5),
});
export type DeviceAuthorization = z.infer<typeof DeviceAuthorizationSchema>;

/**
 * The device sign-in could not complete. `reason` says which step; `message`
 * is the text the terminal shows.
 */
class DeviceSignInError extends Data.TaggedError('DeviceSignInError')<{
  readonly reason: 'request' | 'poll' | 'expired' | 'denied';
  readonly message: string;
  readonly cause?: unknown;
}> {}

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

const deviceCodeExpired = () =>
  new DeviceSignInError({
    reason: 'expired',
    message:
      'The sign-in code expired before it was approved. Run the sign-in again to get a fresh code.',
  });

/** Start a device authorization with the auth server. */
export const requestDeviceAuthorization = Effect.fn(
  'supabaseAuthDeviceCode.requestDeviceAuthorization',
)(function* () {
  const response = yield* postOAuth({
    url: `${DEVICE_AUTH_BASE_URL}/code`,
    headers: JSON_HEADERS,
    body: '',
    timeoutMs: DEVICE_AUTH_REQUEST_TIMEOUT_MS,
    networkErrorMessage: 'Device sign-in request failed',
  }).pipe(
    Effect.mapError(
      (error) =>
        new DeviceSignInError({
          reason: 'request',
          message: error.message,
          cause: error.cause,
        }),
    ),
  );
  if (!response.ok) {
    return yield* new DeviceSignInError({
      reason: 'request',
      message: `Device sign-in is unavailable right now (HTTP ${response.status}). Try again, or use \`texra login --no-browser\`.`,
    });
  }
  return yield* parseOAuthJson(
    response,
    DeviceAuthorizationSchema,
    'Device sign-in returned an unexpected response.',
  ).pipe(
    Effect.mapError(
      (error) =>
        new DeviceSignInError({
          reason: 'request',
          message: error.message,
          cause: error.cause,
        }),
    ),
  );
});

/** Best-effort read of the RFC 6749 `error` code; anything else is absent. */
function deviceErrorCode(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    return isObject(body) && typeof body.error === 'string'
      ? body.error
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One poll of the token endpoint. Pending is a typed failure so the shared
 * poll keeps going; a few consecutive transient failures (headless/SSH
 * connections blip) are pending too, counted in `transientFailures`.
 */
const pollOnce = Effect.fn('supabaseAuthDeviceCode.pollOnce')(function* (
  deviceCode: string,
  transientFailures: Ref.Ref<number>,
) {
  const transient = (fail: DeviceSignInError) =>
    Effect.gen(function* () {
      const failures = yield* Ref.updateAndGet(transientFailures, (n) => n + 1);
      if (failures >= MAX_TRANSIENT_POLL_FAILURES) return yield* fail;
      return yield* new DeviceAuthorizationPending({ slowDown: false });
    });

  const response = yield* postOAuth({
    url: `${DEVICE_AUTH_BASE_URL}/token`,
    headers: JSON_HEADERS,
    body: JSON.stringify({ device_code: deviceCode }),
    timeoutMs: DEVICE_AUTH_REQUEST_TIMEOUT_MS,
    networkErrorMessage: 'Device sign-in poll failed',
  }).pipe(
    Effect.catchTag('OAuthNetworkError', (error) =>
      transient(
        new DeviceSignInError({
          reason: 'poll',
          message: error.message,
          cause: error.cause,
        }),
      ),
    ),
  );

  if (response.ok) {
    return yield* parseOAuthJson(
      response,
      GitHubTokenExchangeSchema,
      'Device sign-in returned an unexpected token response.',
    ).pipe(
      Effect.mapError(
        (error) =>
          new DeviceSignInError({
            reason: 'poll',
            message: error.message,
            cause: error.cause,
          }),
      ),
    );
  }

  const errorCode = deviceErrorCode(response.text);
  switch (errorCode) {
    case 'authorization_pending':
    case 'slow_down':
      yield* Ref.set(transientFailures, 0);
      return yield* new DeviceAuthorizationPending({
        slowDown: errorCode === 'slow_down',
      });
    case 'expired_token':
      return yield* deviceCodeExpired();
    case 'access_denied':
      return yield* new DeviceSignInError({
        reason: 'denied',
        message: 'Sign-in was denied in the browser.',
      });
    default:
      if (response.status === 429 || response.status >= 500) {
        return yield* transient(
          new DeviceSignInError({
            reason: 'poll',
            message: `Device sign-in failed (HTTP ${response.status}). Try again.`,
          }),
        );
      }
      return yield* new DeviceSignInError({
        reason: 'poll',
        message: `Device sign-in failed: ${errorCode ?? `HTTP ${response.status}`}`,
      });
  }
});

/**
 * Poll the token endpoint until the device code is approved, honoring the
 * RFC 8628 `interval`, `slow_down`, `authorization_pending`, `access_denied`,
 * and `expired_token` semantics.
 */
export const pollForDeviceSession = Effect.fn(
  'supabaseAuthDeviceCode.pollForDeviceSession',
)(function* (
  authorization: Pick<
    DeviceAuthorization,
    'device_code' | 'expires_in' | 'interval'
  >,
) {
  const transientFailures = yield* Ref.make(0);
  return yield* pollDeviceAuthorization({
    poll: pollOnce(authorization.device_code, transientFailures),
    intervalMs: authorization.interval * 1000,
    expiresInMs: authorization.expires_in * 1000,
    slowDownIncrementMs: SLOW_DOWN_INCREMENT_SECONDS * 1000,
  }).pipe(Effect.catchTag('DeviceCodeTimedOut', () => deviceCodeExpired()));
});
