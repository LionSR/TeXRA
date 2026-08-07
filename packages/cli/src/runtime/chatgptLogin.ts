import {
  codexCoordinator,
  loginWithDeviceCode,
  loginWithLoopback,
  type CodexSession,
} from '@auth/codex';
import {
  setPreferCodexSubscription,
  type CodexSubscriptionPreferenceUpdate,
} from '@model/codex/codexPreference';

import {
  shouldUseSubscriptionDeviceCode,
  signInCliSubscription,
  signOutCliSubscription,
  subscriptionSignOutPreferenceMessage,
  type CliSubscriptionLoginTransportInit,
  type CliSubscriptionSignOutResult,
} from './subscriptionLogin';
import type { CliContext } from './cliContext';

export type CliChatGptLoginInit = CliSubscriptionLoginTransportInit;

export interface CliChatGptLoginOptions {
  readonly writeProgress: (message: string) => void;
  readonly signal?: AbortSignal;
}

export type CliChatGptSignOutResult = CliSubscriptionSignOutResult & {
  readonly preferenceUpdate?: CodexSubscriptionPreferenceUpdate;
};

export function shouldUseChatGptDeviceCode(
  context: CliContext,
  init: CliChatGptLoginInit,
): boolean {
  return shouldUseSubscriptionDeviceCode(context, init);
}

export async function signInCliChatGpt(
  init: CliChatGptLoginInit,
  options: CliChatGptLoginOptions,
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
  result: CliChatGptSignOutResult,
): string {
  return subscriptionSignOutPreferenceMessage({
    displayName: 'ChatGPT',
    disabledFor: 'Codex models',
    result,
  });
}

export async function signOutCliChatGpt(): Promise<CliChatGptSignOutResult> {
  return signOutCliSubscription({
    coordinator: codexCoordinator(),
    disablePreference: () => setPreferCodexSubscription(false),
  });
}
