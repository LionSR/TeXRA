// Local imports - GitHub subscriptions
import { SharedIssuePollingSource } from '@tools/github/IssuePollingSource';
import { SharedPRPollingSource } from '@tools/github/PRPollingSource';
import { SharedRepoPollingSource } from '@tools/github/RepoPollingSource';
import {
  issueSubscriptionRegistry,
  prSubscriptionRegistry,
  repoSubscriptionRegistry,
} from '@tools/github/subscriptionBindings';

interface GitHubSubscriptionOwner {
  readonly streamId: string;
  readonly label: string;
}

interface GitHubSubscriptionEntry {
  readonly key: string;
  readonly owners: readonly GitHubSubscriptionOwner[];
}

/** Builds the shared PR, issue, and repository subscription presentation. */
export function listGitHubSubscriptionEntries(
  getStreamLabel: (streamId: string) => string | undefined,
): GitHubSubscriptionEntry[] {
  function toEntry(binding: {
    key: string;
    streamIds: readonly string[];
  }): GitHubSubscriptionEntry {
    return {
      key: binding.key,
      owners: binding.streamIds.map((streamId) => ({
        streamId,
        label: getStreamLabel(streamId) ?? streamId,
      })),
    };
  }

  return [
    ...prSubscriptionRegistry
      .list(SharedPRPollingSource.activeKeys())
      .map(toEntry),
    ...repoSubscriptionRegistry
      .list(SharedRepoPollingSource.activeKeys())
      .map(toEntry),
    ...issueSubscriptionRegistry
      .list(SharedIssuePollingSource.activeKeys())
      .map(toEntry),
  ];
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
