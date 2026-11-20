import { Command } from 'effect/cli';
import type { SubscriptionAuthProvider } from '@texra-ai/harness/schemas';

import { CHATGPT_AUTH, GROK_AUTH } from '@ui/copy/accountAuth';

import { defineSubscriptionAuthCommand } from './_helpers/subscriptionAuthCommand';

// One group per subscription provider, and every provider has one.
const PROVIDER_COMMANDS = {
  chatgpt: defineSubscriptionAuthCommand({
    providerId: 'chatgpt',
    rootDescription:
      'Sign in with your ChatGPT subscription to use OpenAI models',
    loginDescription: 'Sign in with your ChatGPT subscription',
    logoutDescription: 'Sign out of your ChatGPT subscription',
    statusDescription: 'Show ChatGPT subscription sign-in status',
    loginPayloadExtras: (account) => ({
      accountId: account.accountId ?? null,
    }),
  }),
  grok: defineSubscriptionAuthCommand({
    providerId: 'grok',
    rootDescription:
      'Sign in with your Grok (xAI SuperGrok) account to use xAI models via subscription',
    loginDescription: 'Sign in with your Grok (xAI SuperGrok) account',
    logoutDescription: 'Sign out of your Grok subscription',
    statusDescription: 'Show Grok subscription sign-in status',
  }),
} as const satisfies Record<SubscriptionAuthProvider, unknown>;

// Every auth verb lives here. There is no TeXRA account to sign in to; a
// bare `texra auth` lists the groups.
export const authCommand = Command.make('auth').pipe(
  Command.withDescription(
    `Sign in with a ${CHATGPT_AUTH.subscriptionLabel} or ${GROK_AUTH.subscriptionLabel}; check status`,
  ),
  Command.withSubcommands([PROVIDER_COMMANDS.chatgpt, PROVIDER_COMMANDS.grok]),
);
