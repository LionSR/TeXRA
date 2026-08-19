// Device-code (RFC 8628 style) sign-in client for the TeXRA CLI.
//
// Protocol layer only: request a device authorization from the auth-device
// edge function, then poll its token endpoint until the user approves the
// code from a browser on any device. Session storage lives with the other
// sign-in flows in `supabaseAuth.ts`.

// Third-party imports
import { z } from 'zod';

// Local imports - auth
import { DEVICE_AUTH_BASE_URL } from '@auth/config';
import { fetchWithTimeout } from '@auth/fetchWithTimeout';
import {
  parseTokenExchangeResponse,
  type GitHubTokenExchangeResponse,
} from '@auth/SupabaseSession';
import {
  deviceCodeAuthorized,
  deviceCodePending,
  pollUntilDeviceAuthorized,
} from '@auth/oauth/deviceCodePoll';

const DEVICE_AUTH_REQUEST_TIMEOUT_MS = 30000;

/** Extra seconds added to the poll interval on an RFC 8628 slow_down. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

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

export interface DeviceAuthPollHooks {
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the device auth edge function URL. */
  readonly baseUrl?: string;
  /** Injectable for tests; defaults to a real setTimeout sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Date.now. */
  readonly now?: () => number;
  /** Optional cancellation for interactive hosts. */
  readonly signal?: AbortSignal;
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

/** Start a device authorization with the auth server. */
export async function requestDeviceAuthorization(
  hooks: DeviceAuthPollHooks = {},
): Promise<DeviceAuthorization> {
  const response = await fetchWithTimeout(
    `${hooks.baseUrl ?? DEVICE_AUTH_BASE_URL}/code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: hooks.signal,
    },
    DEVICE_AUTH_REQUEST_TIMEOUT_MS,
    'Device sign-in request timed out',
    hooks.fetchImpl,
  );
  if (!response.ok) {
    throw new Error(
      `Device sign-in is unavailable right now (HTTP ${response.status}). Try again, or use \`texra login --no-browser\`.`,
    );
  }
  const parsed = DeviceAuthorizationSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new Error('Device sign-in returned an unexpected response.');
  }
  return parsed.data;
}

/**
 * Poll the token endpoint until the device code is approved, honoring the
 * RFC 8628 `interval`, `slow_down`, `authorization_pending`, `access_denied`,
 * and `expired_token` semantics.
 */
export async function pollForDeviceSession(
  authorization: Pick<
    DeviceAuthorization,
    'device_code' | 'expires_in' | 'interval'
  >,
  hooks: DeviceAuthPollHooks = {},
): Promise<GitHubTokenExchangeResponse> {
  const now = hooks.now ?? Date.now;
  let transientFailures = 0;

  return pollUntilDeviceAuthorized({
    intervalMs: authorization.interval * 1000,
    deadlineMs: now() + authorization.expires_in * 1000,
    signal: hooks.signal,
    sleep: hooks.sleep,
    now,
    // Sleep first, then check the deadline (historical CLI timing).
    checkDeadlineBeforeSleep: false,
    createTimeoutError: deviceCodeExpiredError,
    attempt: async () => {
      let response: Response;
      try {
        response = await fetchWithTimeout(
          `${hooks.baseUrl ?? DEVICE_AUTH_BASE_URL}/token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_code: authorization.device_code }),
            signal: hooks.signal,
          },
          DEVICE_AUTH_REQUEST_TIMEOUT_MS,
          'Device sign-in poll timed out',
          hooks.fetchImpl,
        );
      } catch (error) {
        hooks.signal?.throwIfAborted();
        // Headless/SSH connections blip; tolerate a few in a row before failing.
        transientFailures += 1;
        if (transientFailures >= MAX_TRANSIENT_POLL_FAILURES) throw error;
        return deviceCodePending();
      }

      if (response.ok) {
        return deviceCodeAuthorized(await parseTokenExchangeResponse(response));
      }

      const errorCode = await readDeviceErrorCode(response);
      switch (errorCode) {
        case 'authorization_pending':
          transientFailures = 0;
          return deviceCodePending();
        case 'slow_down':
          transientFailures = 0;
          return deviceCodePending(SLOW_DOWN_INCREMENT_SECONDS * 1000);
        case 'expired_token':
          throw deviceCodeExpiredError();
        case 'access_denied':
          throw new Error('Sign-in was denied in the browser.');
        default:
          if (response.status === 429 || response.status >= 500) {
            transientFailures += 1;
            if (transientFailures >= MAX_TRANSIENT_POLL_FAILURES) {
              throw new Error(
                `Device sign-in failed (HTTP ${response.status}). Try again.`,
              );
            }
            return deviceCodePending();
          }
          throw new Error(
            `Device sign-in failed: ${errorCode ?? `HTTP ${response.status}`}`,
          );
      }
    },
  });
}

function deviceCodeExpiredError(): Error {
  return new Error(
    'The sign-in code expired before it was approved. Run the sign-in again to get a fresh code.',
  );
}

async function readDeviceErrorCode(
  response: Response,
): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' ? error : undefined;
}
