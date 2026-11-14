import type { SubscriptionTarget } from './subscriptionTarget';

export const GITHUB_POLL_INTERVAL_MS = 30_000;

/** How many same-kind events one poll reports one by one: at this many or
 *  more (a base-branch push conflicting every open PR, a matrix build
 *  failing a fleet of checks), it reports one summary instead. */
export const COALESCE_THRESHOLD = 3;

/** How many targets of each kind one process polls at once. */
export const MAX_SUBSCRIPTIONS: Readonly<
  Record<SubscriptionTarget['_tag'], number>
> = { pull: 25, issue: 10, repo: 3 };
