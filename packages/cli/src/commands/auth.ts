import { Command } from 'effect/cli';
import type { SubscriptionAuthProvider } from '@texra-ai/worldline/schemas';

import { SUBSCRIPTION_AUTH_COPY } from '@ui/copy/accountAuth';

import { defineSubscriptionAuthCommand } from './_helpers/subscriptionAuthCommand';

// One group per subscription provider, and every provider has one.
const PROVIDER_COMMANDS = {
  chatgpt: defineSubscriptionAuthCommand({
    providerId: 'chatgpt',
    loginPayloadExtras: (account) => ({
      accountId: account.accountId ?? null,
    }),
  }),
  grok: defineSubscriptionAuthCommand({ providerId: 'grok' }),
} as const satisfies Record<SubscriptionAuthProvider, unknown>;

// Every auth verb lives here. There is no TeXRA account to sign in to; a
// bare `texra auth` lists the groups.
export const authCommand = Command.make('auth').pipe(
  Command.withDescription(
    `Sign in with a ${SUBSCRIPTION_AUTH_COPY.chatgpt.subscriptionLabel} or ${SUBSCRIPTION_AUTH_COPY.grok.subscriptionLabel}; check status`,
  ),
  Command.withSubcommands([PROVIDER_COMMANDS.chatgpt, PROVIDER_COMMANDS.grok]),
);
