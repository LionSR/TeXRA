/**
 * Device-code sign-in for Codex OAuth (headless / SSH / non-TTY).
 *
 * The user opens a URL and types a one-time code; we poll until they approve.
 * Host-neutral: the host renders the prompt (`onPrompt`) however it likes.
 *
 * One Effect program per sign-in: the requests, the spaced poll, and the
 * expiry bound run on one fiber, and the caller's `AbortSignal` becomes
 * fiber interruption at the single run boundary in {@link loginWithDeviceCode}.
 * The Promise API and the errors it rejects with are unchanged.
 */
// Third-party imports
import { Cause, Data, Effect, Exit } from 'effect';

// Local imports - oauth, platform
import {
  deviceAuthorizationThrowable,
  pollDeviceAuthorization,
} from '@auth/oauth/deviceAuthorization';
import { effectRuntime } from '@platform/processRuntime';

// Local imports - codex
import { CODEX_DEVICE_VERIFICATION_URL } from './codexConstants';
import { type CodexSessionCoordinator } from './CodexSessionCoordinator';
import { CodexAuthError, type CodexSession } from './codexSessionTypes';
import { pollDeviceToken, requestDeviceUserCode } from './codexOAuthClient';

/**
 * Fallback lifetime for the user code when the endpoint omits `expires_in`.
 * The server's value wins whenever it sends one (RFC 8628).
 */
const DEVICE_TIMEOUT_FALLBACK_MS = 15 * 60 * 1000;

/** The usercode endpoint answered without a code to show the user. */
class DeviceCodeMissing extends Data.TaggedError('DeviceCodeMissing')<{
  readonly message: string;
}> {}

interface CodexDevicePrompt {
  /** The one-time code the user types at the verification URL. */
  userCode: string;
  /** Where the user enters the code. */
  verificationUrl: string;
}

export interface CodexDeviceLoginOptions {
  coordinator: CodexSessionCoordinator;
  /** Show the user the verification URL + one-time code. */
  onPrompt: (prompt: CodexDevicePrompt) => void;
  signal?: AbortSignal;
}

const loginProgram = Effect.fn('codexDeviceLogin.loginWithDeviceCode')(
  function* (options: CodexDeviceLoginOptions) {
    const userCodeResponse = yield* requestDeviceUserCode();
    const userCode = userCodeResponse.user_code ?? userCodeResponse.usercode;
    if (!userCode) {
      return yield* new DeviceCodeMissing({
        message: 'ChatGPT did not return a device code. Try again.',
      });
    }

    options.onPrompt({
      userCode,
      verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    });

    return yield* pollDeviceAuthorization({
      poll: pollDeviceToken({
        deviceAuthId: userCodeResponse.device_auth_id,
        userCode,
      }),
      complete: (token) =>
        options.coordinator.completeDeviceLogin({
          authorizationCode: token.authorization_code,
          codeVerifier: token.code_verifier,
        }),
      intervalMs: userCodeResponse.interval * 1000,
      expiresInMs:
        userCodeResponse.expires_in == null
          ? DEVICE_TIMEOUT_FALLBACK_MS
          : userCodeResponse.expires_in * 1000,
    });
  },
  Effect.mapError((error) =>
    error._tag === 'DeviceCodeMissing'
      ? new Error(error.message)
      : deviceAuthorizationThrowable(error, CodexAuthError),
  ),
);

/**
 * Run the device-code flow end to end and persist the session. Resolves to the
 * stored session once the user approves; rejects on timeout or a hard failure.
 */
export async function loginWithDeviceCode(
  options: CodexDeviceLoginOptions,
): Promise<CodexSession> {
  const { signal } = options;
  signal?.throwIfAborted();
  let exit: Exit.Exit<CodexSession, unknown>;
  try {
    exit = await effectRuntime().runPromiseExit(loginProgram(options), {
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
  if (Exit.isSuccess(exit)) return exit.value;
  if (signal?.aborted) throw signal.reason;
  throw Cause.squash(exit.cause);
}
