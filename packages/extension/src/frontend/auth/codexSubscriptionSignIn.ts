// Local imports
import {
  codexCoordinator,
  loginWithDeviceCode,
  loginWithLoopback,
} from '@auth/codex';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import { setPreferCodexSubscription } from '@model/codex/codexPreference';

import { signInWithSubscription } from './subscriptionSignIn';

/** Run ChatGPT sign-in and enable subscription routing for Codex models. */
export async function signInWithChatGptSubscription(
  channel: string,
): Promise<boolean> {
  return signInWithSubscription(channel, {
    coordinator: codexCoordinator,
    loginWithDeviceCode,
    loginWithLoopback,
    accountLabel: codexAccountLabel,
    setPreferSubscription: setPreferCodexSubscription,
    nouns: {
      provider: 'ChatGPT',
      session: 'ChatGPT',
      copyTarget: 'ChatGPT',
      models: 'Codex',
    },
  });
}
