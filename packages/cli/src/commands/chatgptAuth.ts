import { defineSubscriptionAuthCommand } from './_helpers/subscriptionAuthCommand';

export const chatgptAuthCommand = defineSubscriptionAuthCommand({
  providerId: 'chatgpt',
  rootDescription: 'Sign in with your ChatGPT subscription to use Codex models',
  loginDescription: 'Sign in with your ChatGPT subscription',
  logoutDescription: 'Sign out of your ChatGPT subscription',
  statusDescription: 'Show ChatGPT subscription sign-in status',
  loginPayloadExtras: (account) => ({ accountId: account.accountId ?? null }),
});
