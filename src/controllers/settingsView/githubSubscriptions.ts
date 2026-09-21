// Third-party imports
import { Effect } from 'effect';

// Local imports - GitHub subscriptions
import type { RunId } from '@shared/schemas';
import { GitHubSubscriptions } from '@tools/github/subscriptionBindings';

interface GitHubSubscriptionOwner {
  readonly runId: RunId;
  readonly label: string;
}

interface GitHubSubscriptionEntry {
  readonly key: string;
  readonly owners: readonly GitHubSubscriptionOwner[];
}

/** Builds the shared PR, issue, and repository subscription presentation. */
export const listGitHubSubscriptionEntries = Effect.fn(
  'githubSubscriptions.listEntries',
)(function* (getRunLabel: (runId: RunId) => string | undefined) {
  const subscriptions = yield* GitHubSubscriptions;

  function toEntry(binding: {
    key: string;
    runIds: readonly RunId[];
  }): GitHubSubscriptionEntry {
    return {
      key: binding.key,
      owners: binding.runIds.map((runId) => ({
        runId,
        label: getRunLabel(runId) ?? runId,
      })),
    };
  }

  return [
    ...subscriptions.pr.list().map(toEntry),
    ...subscriptions.repo.list().map(toEntry),
    ...subscriptions.issue.list().map(toEntry),
  ];
});

/**
 * What both Git tabs say when {@link unsubscribeGitHubKey} matched nothing —
 * the key was already unbound, or never had this shape. The condition is
 * decided here, so the sentence is too.
 */
export function noActiveGitHubSubscriptionMessage(key: string): string {
  return `No active subscription for ${key}.`;
}

/**
 * Removes every binding for a GitHub URL-shaped subscription key.
 * Repo keys are exactly `owner/repo`; a malformed, legacy, or future key
 * shape must not silently default to the repo registry (a destructive unbind),
 * so it is treated as an explicit no-match instead.
 */
export const unsubscribeGitHubKey = Effect.fn(
  'githubSubscriptions.unsubscribeKey',
)(function* (key: string) {
  const subscriptions = yield* GitHubSubscriptions;
  if (key.includes('/pulls/')) return subscriptions.pr.unbindAll(key);
  if (key.includes('/issues/')) return subscriptions.issue.unbindAll(key);
  if (/^[^/\s]+\/[^/\s]+$/.test(key)) {
    return subscriptions.repo.unbindAll(key);
  }
  return 0;
});
