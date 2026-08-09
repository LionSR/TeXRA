import {
  loginWithDeviceCode,
  loginWithLoopback,
  xaiCoordinator,
  type XaiSession,
} from '@auth/xai';
import { setPreferXaiSubscription } from '@model/xai/xaiPreference';

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

export function shouldUseGrokDeviceCode(
  context: CliContext,
  init: CliSubscriptionLoginTransportInit,
): boolean {
  return shouldUseSubscriptionDeviceCode(context, init);
}

export async function signInCliGrok(
  init: CliSubscriptionLoginTransportInit,
  options: CliSubscriptionLoginOptions,
): Promise<XaiSession> {
  return signInCliSubscription({
    coordinator: xaiCoordinator(),
    displayName: 'Grok',
    init,
    writeProgress: options.writeProgress,
    signal: options.signal,
    loginWithDeviceCode,
    loginWithLoopback,
  });
}

export function grokSignOutPreferenceMessage(
  result: CliSubscriptionSignOutResult,
): string {
  return subscriptionSignOutPreferenceMessage({
    displayName: 'Grok',
    disabledFor: 'xAI models',
    result,
  });
}

export async function signOutCliGrok(): Promise<CliSubscriptionSignOutResult> {
  return signOutCliSubscription({
    coordinator: xaiCoordinator(),
    disablePreference: () => setPreferXaiSubscription(false),
  });
}
