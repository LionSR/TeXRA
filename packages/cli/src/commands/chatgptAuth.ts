import { codexCoordinator } from '@auth/codex';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import { setPreferCodexSubscription } from '@model/codex/codexPreference';

import {
  chatGptSignOutOutcomeMessage,
  signInCliChatGpt,
  signOutCliChatGpt,
} from '../runtime/chatgptLogin';

import { defineSubscriptionAuthCommand } from './_helpers/subscriptionAuthCommand';

export const chatgptAuthCommand = defineSubscriptionAuthCommand({
  commandName: 'chatgpt',
  displayName: 'ChatGPT',
  rootDescription: 'Sign in with your ChatGPT subscription to use Codex models',
  loginDescription: 'Sign in with your ChatGPT subscription',
  logoutDescription: 'Sign out of your ChatGPT subscription',
  statusDescription: 'Show ChatGPT subscription sign-in status',
  enabledFor: 'Codex models',
  ndjsonKind: 'chatgpt-auth',
  accountLabel: codexAccountLabel,
  loginPayloadExtras: (session) => ({ accountId: session.accountId ?? null }),
  signIn: signInCliChatGpt,
  signOut: signOutCliChatGpt,
  signOutOutcomeMessage: chatGptSignOutOutcomeMessage,
  setPreferSubscription: setPreferCodexSubscription,
  getStatus: () => codexCoordinator().getStatus(),
});
