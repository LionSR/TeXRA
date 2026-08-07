// Local imports
import {
  loginWithDeviceCode,
  loginWithLoopback,
  xaiAccountLabel,
  xaiCoordinator,
} from '@auth/xai';
import { setPreferXaiSubscription } from '@model/xai/xaiPreference';

import { signInWithSubscription } from './subscriptionSignIn';

/** Run Grok sign-in and enable subscription routing for xAI models. */
export async function signInWithGrokSubscription(
  channel: string,
): Promise<boolean> {
  return signInWithSubscription(channel, {
    coordinator: xaiCoordinator,
    loginWithDeviceCode,
    loginWithLoopback,
    accountLabel: xaiAccountLabel,
    setPreferSubscription: setPreferXaiSubscription,
    nouns: {
      provider: 'Grok',
      session: 'xAI',
      copyTarget: 'Grok / xAI',
      models: 'xAI',
    },
  });
}
