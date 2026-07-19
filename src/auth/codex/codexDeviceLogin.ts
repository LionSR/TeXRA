/**
 * Device-code sign-in for Codex OAuth (headless / SSH / non-TTY).
 *
 * The user opens a URL and types a one-time code; we poll until they approve.
 * Host-neutral: the host renders the prompt (`onPrompt`) however it likes.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { CODEX_DEVICE_VERIFICATION_URL } from './codexConstants';
import {
  type CodexLogger,
  type CodexSessionCoordinator,
} from './CodexSessionCoordinator';
import { CodexAuthError, type CodexSession } from './codexSessionTypes';
import {
  deviceUserCode,
  pollDeviceToken,
  requestDeviceUserCode,
} from './codexOAuthClient';

const DEVICE_TIMEOUT_MS = 15 * 60 * 1000;

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
  /** Optional heartbeat called once per poll (e.g. to print a dot). */
  onPoll?: () => void;
  log?: CodexLogger;
  signal?: AbortSignal;
}

/**
 * Run the device-code flow end to end and persist the session. Resolves to the
 * stored session once the user approves; rejects on timeout or a hard failure.
 */
export async function loginWithDeviceCode(
  options: CodexDeviceLoginOptions,
): Promise<CodexSession> {
  const userCodeResponse = await requestDeviceUserCode(options.signal);
  const userCode = deviceUserCode(userCodeResponse);
  if (!userCode) {
    throw new Error('ChatGPT did not return a device code. Try again.');
  }
  const intervalMs = userCodeResponse.interval * 1000;

  options.onPrompt({
    userCode,
    verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
  });

  const deadline = Date.now() + DEVICE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(intervalMs, undefined, { signal: options.signal });
    options.onPoll?.();
    try {
      const token = await pollDeviceToken(
        {
          deviceAuthId: userCodeResponse.device_auth_id,
          userCode,
        },
        options.signal,
      );
      options.signal?.throwIfAborted();
      return await options.coordinator.completeDeviceLogin({
        authorizationCode: token.authorization_code,
        codeVerifier: token.code_verifier,
      });
    } catch (error) {
      if (error instanceof CodexAuthError && error.kind === 'pending') {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Device-code sign-in timed out. Run sign-in again.');
}
