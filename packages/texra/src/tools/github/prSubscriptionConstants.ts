import type { SubscriptionTarget } from './subscriptionTarget';

export const GITHUB_POLL_INTERVAL_MS = 30_000;

/** How many targets of each kind one process polls at once. */
export const MAX_SUBSCRIPTIONS: Readonly<
  Record<SubscriptionTarget['_tag'], number>
> = { pull: 25, issue: 10, repo: 3 };
