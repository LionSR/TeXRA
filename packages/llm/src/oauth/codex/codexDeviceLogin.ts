/**
 * Device-code sign-in for Codex OAuth (headless / SSH / non-TTY).
 *
 * The user opens a URL and types a one-time code; we poll until they approve.
 * Host-neutral: the host renders the prompt (`onPrompt`) however it likes.
 *
 * One Effect program per sign-in: the requests, the spaced poll, and the
 * expiry bound run on one fiber. The host runs it at its own edge, where its
 * `AbortSignal` (when it has one) becomes fiber interruption; interruption
 * reaches the requests and the wait, while persisting the approved session
 * runs to completion once started.
 */
// Third-party imports
import { Data, Effect } from 'effect';

// Local imports - oauth
import {
  completeDeviceSession,
  pollDeviceAuthorization,
  type DeviceLoginOptions,
} from '../deviceAuthorization.js';

// Local imports - codex
import {
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_VERIFICATION_URL,
} from './codexConstants.js';
import { pollDeviceToken, requestDeviceUserCode } from './codexOAuthClient.js';
import type { CodexSession } from './codexSessionTypes.js';

/**
 * Fallback lifetime for the user code when the endpoint omits `expires_in`.
 * The server's value wins whenever it sends one (RFC 8628).
 */
const DEVICE_TIMEOUT_FALLBACK_MS = 15 * 60 * 1000;

/** The usercode endpoint answered without a code to show the user. */
class DeviceCodeMissing extends Data.TaggedError('DeviceCodeMissing')<{
  readonly message: string;
}> {}

/**
 * Run the device-code flow end to end and persist the session. Succeeds with
 * the stored session once the user approves; fails on timeout or a hard
 * failure with a tagged error whose `message` is the user-facing text.
 */
export const codexLoginWithDeviceCode = Effect.fn(
  'codexDeviceLogin.loginWithDeviceCode',
)(function* (options: DeviceLoginOptions<CodexSession>) {
  const userCodeResponse = yield* requestDeviceUserCode();
  const userCode = userCodeResponse.user_code ?? userCodeResponse.usercode;
  if (!userCode) {
    return yield* new DeviceCodeMissing({
      message: 'ChatGPT did not return a device code. Try again.',
    });
  }

  yield* options.onPrompt({
    userCode,
    verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
  });

  const token = yield* pollDeviceAuthorization({
    poll: pollDeviceToken({
      deviceAuthId: userCodeResponse.device_auth_id,
      userCode,
    }),
    intervalMs: userCodeResponse.interval * 1000,
    expiresInMs:
      userCodeResponse.expires_in == null
        ? DEVICE_TIMEOUT_FALLBACK_MS
        : userCodeResponse.expires_in * 1000,
  });

  return yield* completeDeviceSession(() =>
    options.coordinator.loginWithCode({
      code: token.authorization_code,
      verifier: token.code_verifier,
      redirectUri: CODEX_DEVICE_REDIRECT_URI,
    }),
  );
});
