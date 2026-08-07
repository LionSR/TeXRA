import { xaiAccountLabel, xaiCoordinator } from '@auth/xai';
import { setPreferXaiSubscription } from '@model/xai/xaiPreference';

import {
  grokSignOutPreferenceMessage,
  shouldUseGrokDeviceCode,
  signInCliGrok,
  signOutCliGrok,
} from '../runtime/grokLogin';

import { defineSubscriptionAuthCommand } from './_helpers/subscriptionAuthCommand';

export const grokAuthCommand = defineSubscriptionAuthCommand({
  commandName: 'grok',
  displayName: 'Grok',
  rootDescription:
    'Sign in with your Grok (xAI SuperGrok) account to use xAI models via subscription',
  loginDescription: 'Sign in with your Grok (xAI SuperGrok) account',
  logoutDescription: 'Sign out of your Grok subscription',
  statusDescription: 'Show Grok subscription sign-in status',
  enabledFor: 'xAI models',
  ndjsonKind: 'grok-auth',
  accountLabel: xaiAccountLabel,
  signIn: signInCliGrok,
  shouldUseDeviceCode: shouldUseGrokDeviceCode,
  signOut: signOutCliGrok,
  signOutPreferenceMessage: grokSignOutPreferenceMessage,
  setPreferSubscription: setPreferXaiSubscription,
  getStatus: () => xaiCoordinator().getStatus(),
});
