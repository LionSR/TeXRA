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

import {
  shouldUseSubscriptionDeviceCode,
  signInCliSubscription,
  signOutCliSubscription,
  subscriptionSignOutPreferenceMessage,
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
  result: CliGrokSignOutResult,
): string {
  return subscriptionSignOutPreferenceMessage({
    displayName: 'Grok',
    disabledFor: 'xAI models',
    result,
  });
}

export async function signOutCliGrok(): Promise<CliGrokSignOutResult> {
  return signOutCliSubscription({
    coordinator: xaiCoordinator(),
    disablePreference: () => setPreferXaiSubscription(false),
  });
}
