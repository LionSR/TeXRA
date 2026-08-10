/**
 * Device-code sign-in for xAI Grok OAuth (headless / SSH / non-TTY).
 *
 * RFC 8628: the user opens a URL and types a one-time code; we poll the token
 * endpoint until they approve. Host-neutral: the host renders the prompt.
 */
// Local imports - oauth
import {
  deviceCodeAuthorized,
  deviceCodePending,
  pollUntilDeviceAuthorized,
} from '@auth/oauth/deviceCodePoll';

// Local imports - xai
import {
  XAI_DEVICE_DEFAULT_EXPIRES_SEC,
  XAI_DEVICE_DEFAULT_INTERVAL_SEC,
  XAI_DEVICE_SLOW_DOWN_INCREMENT_SEC,
} from './xaiConstants';
import { type XaiSessionCoordinator } from './XaiSessionCoordinator';
import { pollDeviceToken, requestDeviceCode } from './xaiOAuthClient';
import { XaiAuthError, type XaiSession } from './xaiSessionTypes';

interface XaiDevicePrompt {
  /** The one-time code the user types at the verification URL. */
  userCode: string;
  /** Where the user enters the code. */
  verificationUrl: string;
  /** Prefill URL when the server supplies `verification_uri_complete`. */
  verificationUrlComplete?: string;
}

export interface XaiDeviceLoginOptions {
  coordinator: XaiSessionCoordinator;
  /** Show the user the verification URL + one-time code. */
  onPrompt: (prompt: XaiDevicePrompt) => void;
  /** Optional heartbeat called once per poll. */
  onPoll?: () => void;
  signal?: AbortSignal;
}

/**
 * Run the device-code flow end to end and persist the session.
 */
export async function loginWithDeviceCode(
  options: XaiDeviceLoginOptions,
): Promise<XaiSession> {
  const device = await requestDeviceCode(options.signal);
  // Floor to 1s so a misbehaving endpoint cannot busy-loop us.
  const intervalMs = Math.max(
    (device.interval ?? XAI_DEVICE_DEFAULT_INTERVAL_SEC) * 1000,
    1000,
  );

  options.onPrompt({
    userCode: device.user_code,
    verificationUrl: device.verification_uri,
    verificationUrlComplete: device.verification_uri_complete ?? undefined,
  });

  const expiresInMs =
    (device.expires_in ?? XAI_DEVICE_DEFAULT_EXPIRES_SEC) * 1000;

  return pollUntilDeviceAuthorized({
    intervalMs,
    deadlineMs: Date.now() + expiresInMs,
    signal: options.signal,
    onPoll: options.onPoll,
    createTimeoutError: () =>
      new Error('Device-code sign-in timed out. Run sign-in again.'),
    attempt: async () => {
      try {
        const tokens = await pollDeviceToken(
          device.device_code,
          options.signal,
        );
        options.signal?.throwIfAborted();
        const session = await options.coordinator.completeDeviceLogin(tokens);
        return deviceCodeAuthorized(session);
      } catch (error) {
        if (error instanceof XaiAuthError && error.kind === 'pending') {
          return deviceCodePending(
            error.message === 'slow_down'
              ? XAI_DEVICE_SLOW_DOWN_INCREMENT_SEC * 1000
              : undefined,
          );
        }
        throw error;
      }
    },
  });
}
