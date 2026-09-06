/**
 * Device-code sign-in for xAI Grok OAuth (headless / SSH / non-TTY).
 *
 * RFC 8628: the user opens a URL and types a one-time code; we poll the token
 * endpoint until they approve. Host-neutral: the host renders the prompt.
 *
 * One Effect program per sign-in: the requests, the spaced poll with
 * `slow_down` growth, and the expiry bound run on one fiber. The host runs it
 * at its own edge, where its `AbortSignal` (when it has one) becomes fiber
 * interruption; interruption reaches the requests and the wait, while
 * persisting the approved tokens runs to completion once started.
 */
// Third-party imports
import { Effect } from 'effect';

// Local imports - oauth
import {
  completeDeviceSession,
  pollDeviceAuthorization,
} from '@auth/oauth/deviceAuthorization';

// Local imports - xai
import {
  XAI_DEVICE_DEFAULT_EXPIRES_SEC,
  XAI_DEVICE_DEFAULT_INTERVAL_SEC,
  XAI_DEVICE_SLOW_DOWN_INCREMENT_SEC,
} from './xaiConstants';
import { type XaiSessionCoordinator } from './XaiSessionCoordinator';
import { pollDeviceToken, requestDeviceCode } from './xaiOAuthClient';

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
}

/**
 * Run the device-code flow end to end and persist the session. Succeeds with
 * the stored session once the user approves; fails with a tagged error whose
 * `message` is the user-facing text.
 */
export const loginWithDeviceCode = Effect.fn(
  'xaiDeviceLogin.loginWithDeviceCode',
)(function* (options: XaiDeviceLoginOptions) {
  const device = yield* requestDeviceCode();
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

  const tokens = yield* pollDeviceAuthorization({
    poll: pollDeviceToken(device.device_code),
    intervalMs,
    expiresInMs: (device.expires_in ?? XAI_DEVICE_DEFAULT_EXPIRES_SEC) * 1000,
    slowDownIncrementMs: XAI_DEVICE_SLOW_DOWN_INCREMENT_SEC * 1000,
  });

  return yield* completeDeviceSession(() =>
    options.coordinator.storeTokens(tokens),
  );
});
