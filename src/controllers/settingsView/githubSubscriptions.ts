// Local imports - GitHub subscriptions
import {
  listIssueSubscriptionBindings,
  listPRSubscriptionBindings,
  listRepoSubscriptionBindings,
  SharedIssuePollingSource,
  SharedPRPollingSource,
  SharedRepoPollingSource,
  unbindAllForIssue,
  unbindAllForPR,
  unbindAllForRepo,
} from '@tools/github';

interface GitHubSubscriptionOwner {
  readonly streamId: string;
  readonly label: string;
}

export interface GitHubSubscriptionEntry {
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
    ...listPRSubscriptionBindings(SharedPRPollingSource.activeKeys()).map(
      toEntry,
    ),
    ...listRepoSubscriptionBindings(SharedRepoPollingSource.activeKeys()).map(
      toEntry,
    ),
    ...listIssueSubscriptionBindings(SharedIssuePollingSource.activeKeys()).map(
      toEntry,
    ),
  ];
}

/** Removes every binding for a GitHub URL-shaped subscription key. */
export function unsubscribeGitHubKey(key: string): number {
  if (key.includes('/pulls/')) return unbindAllForPR(key);
  if (key.includes('/issues/')) return unbindAllForIssue(key);
  return unbindAllForRepo(key);
}
