/**
 * Device-code sign-in for Kimi Code OAuth (the only flow the backend offers).
 *
 * The user opens a URL and approves (the complete URI usually embeds the
 * one-time code); we poll until they do. Host-neutral: the host renders the
 * prompt (`onPrompt`) however it likes.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { KIMI_CODE_DEVICE_TIMEOUT_MS } from './kimiCodeConstants';
import {
  type KimiCodeLogger,
  type KimiCodeSessionCoordinator,
} from './KimiCodeSessionCoordinator';
import { type KimiCodeSession } from './kimiCodeSessionTypes';
import {
  pollDeviceToken,
  requestDeviceUserCode,
} from './kimiCodeOAuthClient';

export interface KimiCodeDevicePrompt {
  /** The one-time code the user confirms at the verification URL. */
  userCode: string;
  /** Where the user approves — prefer this (usually embeds the code). */
  verificationUrl: string;
}

export interface KimiCodeDeviceLoginOptions {
  coordinator: KimiCodeSessionCoordinator;
  /** Show the user the verification URL + one-time code. */
  onPrompt: (prompt: KimiCodeDevicePrompt) => void;
  /** Optional heartbeat called once per poll (e.g. to print a dot). */
  onPoll?: () => void;
  log?: KimiCodeLogger;
}

/**
 * Run the device-code flow end to end and persist the session. Resolves to the
 * stored session once the user approves; rejects on timeout, denial, or a hard
 * failure.
 */
export async function loginWithKimiCodeDeviceCode(
  options: KimiCodeDeviceLoginOptions,
): Promise<KimiCodeSession> {
  const authorization = await requestDeviceUserCode();
  const verificationUrl =
    authorization.verification_uri_complete ?? authorization.verification_uri;
  if (!verificationUrl) {
    throw new Error('Kimi Code did not return a verification URL. Try again.');
  }
  let intervalMs = authorization.interval * 1000;

  options.onPrompt({ userCode: authorization.user_code, verificationUrl });

  const deadline = Date.now() + KIMI_CODE_DEVICE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    options.onPoll?.();
    const result = await pollDeviceToken(authorization.device_code);
    switch (result.kind) {
      case 'success':
        return options.coordinator.completeDeviceLogin(result.token);
      case 'pending':
        // Back off when the server asks us to slow down.
        if (result.errorCode === 'slow_down') intervalMs += 5000;
        continue;
      case 'expired':
        throw new Error('Kimi Code device code expired. Run sign-in again.');
      case 'denied':
        throw new Error(
          `Kimi Code sign-in was denied${result.description ? `: ${result.description}` : '.'}`,
        );
    }
  }
  throw new Error('Device-code sign-in timed out. Run sign-in again.');
}
