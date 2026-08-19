import { defineSubscriptionAuthCommand } from './_helpers/subscriptionAuthCommand';

export const grokAuthCommand = defineSubscriptionAuthCommand({
  providerId: 'grok',
  commandName: 'grok',
  rootDescription:
    'Sign in with your Grok (xAI SuperGrok) account to use xAI models via subscription',
  loginDescription: 'Sign in with your Grok (xAI SuperGrok) account',
  logoutDescription: 'Sign out of your Grok subscription',
  statusDescription: 'Show Grok subscription sign-in status',
  ndjsonKind: 'grok-auth',
});
