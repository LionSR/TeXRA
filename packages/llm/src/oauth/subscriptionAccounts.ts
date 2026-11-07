/**
 * The process's subscription accounts: one coordinator per subscription over
 * one secret store, keyed by the route that bills it.
 */
import { Context, Effect } from 'effect';

import {
  CHATGPT_POLICY,
  type ChatgptSession,
} from './chatgpt/chatgptProvider.js';
import { SubscriptionOAuthCoordinator } from './SubscriptionOAuthCoordinator.js';
import { XAI_POLICY, type XaiSession } from './xai/xaiProvider.js';
import type { CredentialStore } from '../providers/credentials.js';
import type { SubscriptionCoordinator } from './subscriptionCoordinator.js';

/**
 * Each subscription's account (its stored session: status, refresh, sign-in
 * and sign-out), named by the route that bills it. Built once over the store
 * that holds the sessions, so every caller of one session shares its lock and
 * a rotated refresh token is spent once; another store is another set of
 * accounts, built with it.
 */
export class SubscriptionAccounts extends Context.Service<
  SubscriptionAccounts,
  {
    readonly 'chatgpt-subscription': SubscriptionCoordinator<ChatgptSession>;
    readonly 'xai-subscription': SubscriptionCoordinator<XaiSession>;
  }
>()('@texra-ai/llm/SubscriptionAccounts') {
  /** The accounts whose sessions `secrets` holds. */
  static make(
    secrets: CredentialStore,
  ): Effect.Effect<SubscriptionAccounts['Service']> {
    return Effect.all({
      'chatgpt-subscription': SubscriptionOAuthCoordinator.make(
        secrets,
        CHATGPT_POLICY,
      ),
      'xai-subscription': SubscriptionOAuthCoordinator.make(
        secrets,
        XAI_POLICY,
      ),
    });
  }
}
