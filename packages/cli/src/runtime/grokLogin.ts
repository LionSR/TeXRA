import {
  loginWithDeviceCode,
  loginWithLoopback,
  xaiCoordinator,
  type XaiSession,
} from '@auth/xai';
import {
  setPreferXaiSubscription,
  type XaiSubscriptionPreferenceUpdate,
} from '@model/xai/xaiPreference';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  shouldUseSubscriptionDeviceCode,
  subscriptionSignOutPreferenceMessage,
  writeCliLoopbackSignInProgress,
  type CliSubscriptionLoginTransportInit,
  type CliSubscriptionSignOutResult,
} from './subscriptionLogin';
import type { CliContext } from './cliContext';

export type CliGrokLoginInit = CliSubscriptionLoginTransportInit;

export interface CliGrokLoginOptions {
  readonly writeProgress: (message: string) => void;
  readonly signal?: AbortSignal;
}

export type CliGrokSignOutResult = CliSubscriptionSignOutResult & {
  readonly preferenceUpdate?: XaiSubscriptionPreferenceUpdate;
};

export function shouldUseGrokDeviceCode(
  context: CliContext,
  init: CliGrokLoginInit,
): boolean {
  return shouldUseSubscriptionDeviceCode(context, init);
}

export async function signInCliGrok(
  init: CliGrokLoginInit,
  options: CliGrokLoginOptions,
): Promise<XaiSession> {
  const coordinator = xaiCoordinator();

  if (init.device) {
    return loginWithDeviceCode({
      coordinator,
      onPrompt: ({ userCode, verificationUrl, verificationUrlComplete }) => {
        const openUrl = verificationUrlComplete ?? verificationUrl;
        options.writeProgress(
          `To sign in with Grok:\n  1. Open ${openUrl}\n  2. Enter the one-time code: ${userCode}\nWaiting for approval... (Ctrl-C cancels)`,
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
        displayName: 'Grok',
        url,
        noBrowser: init.noBrowser,
      }),
    signal: options.signal,
  });
}

export function grokSignOutPreferenceMessage(
  result: CliGrokSignOutResult,
): string {
  return subscriptionSignOutPreferenceMessage({
    displayName: 'Grok',
    disabledFor: 'xAI models',
    result,
  });
}

export async function signOutCliGrok(): Promise<CliGrokSignOutResult> {
  await xaiCoordinator().signOut();
  try {
    return { preferenceUpdate: await setPreferXaiSubscription(false) };
  } catch (error: unknown) {
    return { preferenceError: toErrorMessage(error) };
  }
}
