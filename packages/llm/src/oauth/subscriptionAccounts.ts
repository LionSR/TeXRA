/**
 * The process's subscription accounts: one coordinator per subscription over
 * one secret store, keyed by the route that bills it.
 */
import { Context, Effect } from 'effect';

import {
  chatgptPolicy,
  type ChatgptSession,
} from './chatgpt/chatgptProvider.js';
import { SubscriptionOAuthCoordinator } from './SubscriptionOAuthCoordinator.js';
import { xaiPolicy, type XaiSession } from './xai/xaiProvider.js';
import type { CredentialStore } from '../providers/credentials.js';
import type { SubscriptionCoordinator } from './subscriptionCoordinator.js';
import type { ClientIdentity } from '../node.js';

/**
 * Each subscription's account (its stored session: status, refresh, sign-in
 * and sign-out), named by the route that bills it. Built once over the store
 * that holds the sessions, so every caller of one session shares its lock and
 * a rotated refresh token is spent once; another store is another set of
 * accounts, built with it. They sign in as `client`, the app they are built
 * for, which the binding of a subscription route reads too.
 */
export class SubscriptionAccounts extends Context.Service<
  SubscriptionAccounts,
  {
    readonly 'chatgpt-subscription': SubscriptionCoordinator<ChatgptSession>;
    readonly 'xai-subscription': SubscriptionCoordinator<XaiSession>;
    /** The app the accounts sign in as. */
    readonly client: ClientIdentity;
  }
>()('@texra-ai/llm/SubscriptionAccounts') {
  /** The accounts whose sessions `secrets` holds, signing in as `client`. */
  static make(
    secrets: CredentialStore,
    client: ClientIdentity,
  ): Effect.Effect<SubscriptionAccounts['Service']> {
    return Effect.all({
      'chatgpt-subscription': SubscriptionOAuthCoordinator.make(
        secrets,
        chatgptPolicy(client),
      ),
      'xai-subscription': SubscriptionOAuthCoordinator.make(
        secrets,
        xaiPolicy(client),
      ),
      client: Effect.succeed(client),
    });
  }
}
