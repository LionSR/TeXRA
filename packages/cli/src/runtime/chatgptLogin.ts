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
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  shouldUseSubscriptionDeviceCode,
  subscriptionSignOutPreferenceMessage,
  writeCliLoopbackSignInProgress,
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
  const coordinator = codexCoordinator();

  if (init.device) {
    return loginWithDeviceCode({
      coordinator,
      onPrompt: ({ userCode, verificationUrl }) => {
        options.writeProgress(
          `To sign in with ChatGPT:\n  1. Open ${verificationUrl}\n  2. Enter the one-time code: ${userCode}\nWaiting for approval... (Ctrl-C cancels)`,
        );
      },
      signal: options.signal,
    });
  }

  return loginWithLoopback({
    coordinator,
    openBrowser: (url) =>
      writeCliLoopbackSignInProgress({
        writeProgress: options.writeProgress,
        displayName: 'ChatGPT',
        url,
        noBrowser: init.noBrowser,
      }),
    signal: options.signal,
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
  await codexCoordinator().signOut();
  try {
    return { preferenceUpdate: await setPreferCodexSubscription(false) };
  } catch (error: unknown) {
    return { preferenceError: toErrorMessage(error) };
  }
}
