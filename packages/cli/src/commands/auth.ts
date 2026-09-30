import { defineCommand } from 'citty';

import { CHATGPT_AUTH, GROK_AUTH } from '@ui/copy/accountAuth';

import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { defineSubscriptionAuthCommand } from './_helpers/subscriptionAuthCommand';

// Every auth verb lives here, one group per subscription provider. There is
// no TeXRA account to sign in to; a bare `texra auth` lists the groups.
export const authCommand = defineCommand({
  meta: {
    name: 'auth',
    description: `Sign in with a ${CHATGPT_AUTH.subscriptionLabel} or ${GROK_AUTH.subscriptionLabel}; check status`,
  },
  args: {
    ...GLOBAL_ARGS,
  },
  subCommands: {
    chatgpt: defineSubscriptionAuthCommand({
      providerId: 'chatgpt',
      rootDescription:
        'Sign in with your ChatGPT subscription to use Codex models',
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
  } as const,
});
