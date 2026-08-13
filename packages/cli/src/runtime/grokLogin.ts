import {
  loginWithDeviceCode,
  loginWithLoopback,
  xaiCoordinator,
  type XaiSession,
} from '@auth/xai';
import { setPreferXaiSubscription } from '@model/xai/xaiPreference';

import {
  signInCliSubscription,
  signOutCliSubscription,
  subscriptionSignOutPreferenceMessage,
  type CliSubscriptionLoginOptions,
  type CliSubscriptionLoginTransportInit,
  type CliSubscriptionSignOutResult,
} from './subscriptionLogin';

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

/**
 * Full Grok sign-out outcome text, owned here so the auth command and the
 * launcher account action report the same lines.
 */
export function grokSignOutOutcomeMessage(
  result: CliSubscriptionSignOutResult,
): string {
  return `Signed out of Grok.\n${grokSignOutPreferenceMessage(result)}`;
}

export async function signOutCliGrok(): Promise<CliSubscriptionSignOutResult> {
  return signOutCliSubscription({
    coordinator: xaiCoordinator(),
    disablePreference: () => setPreferXaiSubscription(false),
  });
}
