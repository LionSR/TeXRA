/**
 * Device-code sign-in for xAI Grok OAuth (headless / SSH / non-TTY).
 *
 * RFC 8628: the user opens a URL and types a one-time code; we poll the token
 * endpoint until they approve. Host-neutral: the host renders the prompt.
 *
 * One Effect program per sign-in: the requests, the spaced poll with
 * `slow_down` growth, and the expiry bound run on one fiber, and the caller's
 * `AbortSignal` becomes fiber interruption at the single run boundary in
 * {@link loginWithDeviceCode}. Interruption reaches the requests and the
 * wait; persisting the approved session runs to completion once started, as
 * the Promise loop always did. The Promise API and the errors it rejects with
 * are unchanged.
 */
// Third-party imports
import { Cause, Effect, Exit } from 'effect';

// Local imports - oauth, platform
import {
  completeDeviceSession,
  deviceAuthorizationThrowable,
  pollDeviceAuthorization,
} from '@auth/oauth/deviceAuthorization';
import { effectRuntime } from '@platform/processRuntime';

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
  signal?: AbortSignal;
}

const loginProgram = Effect.fn('xaiDeviceLogin.loginWithDeviceCode')(
  function* (options: XaiDeviceLoginOptions) {
    // The fiber runs uninterruptible (see `loginWithDeviceCode`); the
    // requests and the wait for approval restore interruption so the caller's
    // abort cancels them, while storing the approved tokens does not.
    const tokens = yield* Effect.interruptible(
      Effect.gen(function* () {
        const device = yield* requestDeviceCode();
        // Floor to 1s so a misbehaving endpoint cannot busy-loop us.
        const intervalMs = Math.max(
          (device.interval ?? XAI_DEVICE_DEFAULT_INTERVAL_SEC) * 1000,
          1000,
        );

        options.onPrompt({
          userCode: device.user_code,
          verificationUrl: device.verification_uri,
          verificationUrlComplete:
            device.verification_uri_complete ?? undefined,
        });

        return yield* pollDeviceAuthorization({
          poll: pollDeviceToken(device.device_code),
          intervalMs,
          expiresInMs:
            (device.expires_in ?? XAI_DEVICE_DEFAULT_EXPIRES_SEC) * 1000,
          slowDownIncrementMs: XAI_DEVICE_SLOW_DOWN_INCREMENT_SEC * 1000,
        });
      }),
    );

    return yield* completeDeviceSession(() =>
      options.coordinator.storeTokens(tokens),
    );
  },
  Effect.mapError((error) => {
    switch (error._tag) {
      case 'DeviceAuthorizationDenied':
        return new XaiAuthError(error.message, 'fatal', error.status);
      case 'DeviceCodeExpired':
        return new XaiAuthError(error.message, 'expired', error.status);
      default:
        return deviceAuthorizationThrowable(error, XaiAuthError);
    }
  }),
);

/**
 * Run the device-code flow end to end and persist the session.
 */
export async function loginWithDeviceCode(
  options: XaiDeviceLoginOptions,
): Promise<XaiSession> {
  const { signal } = options;
  signal?.throwIfAborted();
  let exit: Exit.Exit<XaiSession, unknown>;
  try {
    // Uninterruptible by default so an abort that lands while the coordinator
    // stores the tokens lets it finish and resolves with that session;
    // `loginProgram` restores interruption for everything before it.
    exit = await effectRuntime().runPromiseExit(loginProgram(options), {
      signal,
      uninterruptible: true,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
  if (Exit.isSuccess(exit)) return exit.value;
  if (signal?.aborted) throw signal.reason;
  throw Cause.squash(exit.cause);
}
