import {
  codexCoordinator,
  loginWithDeviceCode,
  loginWithLoopback,
  type CodexSession,
} from '@auth/codex';
import { setPreferCodexSubscription } from '@model/codex/codexPreference';

import {
  signInCliSubscription,
  signOutCliSubscription,
  subscriptionSignOutPreferenceMessage,
  type CliSubscriptionLoginOptions,
  type CliSubscriptionLoginTransportInit,
  type CliSubscriptionSignOutResult,
} from './subscriptionLogin';

export async function signInCliChatGpt(
  init: CliSubscriptionLoginTransportInit,
  options: CliSubscriptionLoginOptions,
): Promise<CodexSession> {
  return signInCliSubscription({
    coordinator: codexCoordinator(),
    displayName: 'ChatGPT',
    init,
    writeProgress: options.writeProgress,
    signal: options.signal,
    loginWithDeviceCode,
    loginWithLoopback,
  });
}

export function chatGptSignOutPreferenceMessage(
  result: CliSubscriptionSignOutResult,
): string {
  return subscriptionSignOutPreferenceMessage({
    displayName: 'ChatGPT',
    disabledFor: 'Codex models',
    result,
  });
}

/**
 * Full ChatGPT sign-out outcome text, owned here so the auth command and the
 * launcher account action report the same lines.
 */
export function chatGptSignOutOutcomeMessage(
  result: CliSubscriptionSignOutResult,
): string {
  return `Signed out of ChatGPT.\n${chatGptSignOutPreferenceMessage(result)}`;
}

export async function signOutCliChatGpt(): Promise<CliSubscriptionSignOutResult> {
  return signOutCliSubscription({
    coordinator: codexCoordinator(),
    disablePreference: () => setPreferCodexSubscription(false),
  });
}
