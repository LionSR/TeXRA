import {
  codexCoordinator,
  loginWithDeviceCode,
  loginWithLoopback,
  type CodexSession,
} from '@auth/codex';
import { setPreferCodexSubscription } from '@model/codex/codexPreference';

import {
  shouldUseSubscriptionDeviceCode,
  signInCliSubscription,
  signOutCliSubscription,
  subscriptionSignOutPreferenceMessage,
  type CliSubscriptionLoginOptions,
  type CliSubscriptionLoginTransportInit,
  type CliSubscriptionSignOutResult,
} from './subscriptionLogin';
import type { CliContext } from './cliContext';

export function shouldUseChatGptDeviceCode(
  context: CliContext,
  init: CliSubscriptionLoginTransportInit,
): boolean {
  return shouldUseSubscriptionDeviceCode(context, init);
}

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

export async function signOutCliChatGpt(): Promise<CliSubscriptionSignOutResult> {
  return signOutCliSubscription({
    coordinator: codexCoordinator(),
    disablePreference: () => setPreferCodexSubscription(false),
  });
}
