import {
  issueKeyToString,
  SharedIssuePollingSource,
  type IssueKey,
} from './IssuePollingSource';
import {
  prKeyToString,
  SharedPRPollingSource,
  type PRSubscribeInput,
} from './PRPollingSource';
import {
  repoKeyToString,
  SharedRepoPollingSource,
  type RepoKey,
  type RepoSubscribeInput,
} from './RepoPollingSource';
import { RunSubscriptionRegistry } from './RunSubscriptionRegistry';

/**
 * The three process-wide subscription registries, one per polling source.
 * Shared by the github_subscription tool (bind/unbind/list) and the settings
 * UI (list/unbindAll) so both see the same ownership.
 */
export const prSubscriptionRegistry = new RunSubscriptionRegistry<
  string,
  PRSubscribeInput
>({
  name: 'PRRunSubscriptionRegistry',
  source: SharedPRPollingSource,
  keyOf: prKeyToString,
});

export const repoSubscriptionRegistry = new RunSubscriptionRegistry<
  RepoKey,
  RepoSubscribeInput
>({
  name: 'RepoRunSubscriptionRegistry',
  source: SharedRepoPollingSource,
  keyOf: repoKeyToString,
});

export const issueSubscriptionRegistry = new RunSubscriptionRegistry<
  string,
  IssueKey
>({
  name: 'IssueRunSubscriptionRegistry',
  source: SharedIssuePollingSource,
  keyOf: issueKeyToString,
});
