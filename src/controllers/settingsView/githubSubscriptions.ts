// Local imports - GitHub subscriptions
import type { RunId } from '@shared/schemas';
import {
  issueSubscriptionRegistry,
  prSubscriptionRegistry,
  repoSubscriptionRegistry,
} from '@tools/github/subscriptionBindings';

interface GitHubSubscriptionOwner {
  readonly runId: RunId;
  readonly label: string;
}

interface GitHubSubscriptionEntry {
  readonly key: string;
  readonly owners: readonly GitHubSubscriptionOwner[];
}

/** Builds the shared PR, issue, and repository subscription presentation. */
export function listGitHubSubscriptionEntries(
  getRunLabel: (runId: RunId) => string | undefined,
): GitHubSubscriptionEntry[] {
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
    ...prSubscriptionRegistry.list().map(toEntry),
    ...repoSubscriptionRegistry.list().map(toEntry),
    ...issueSubscriptionRegistry.list().map(toEntry),
  ];
}

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
export function unsubscribeGitHubKey(key: string): number {
  if (key.includes('/pulls/')) return prSubscriptionRegistry.unbindAll(key);
  if (key.includes('/issues/')) return issueSubscriptionRegistry.unbindAll(key);
  if (/^[^/\s]+\/[^/\s]+$/.test(key)) {
    return repoSubscriptionRegistry.unbindAll(key);
  }
  return 0;
}
