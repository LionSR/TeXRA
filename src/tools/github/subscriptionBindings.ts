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
import { StreamSubscriptionRegistry } from './StreamSubscriptionRegistry';

/**
 * The three process-wide subscription registries, one per polling source.
 * Shared by the github_subscription tool (bind/unbind/list) and the settings
 * UI (list/unbindAll) so both see the same ownership.
 */
export const prSubscriptionRegistry = new StreamSubscriptionRegistry<
  string,
  PRSubscribeInput
>({
  name: 'PRStreamSubscriptionRegistry',
  source: SharedPRPollingSource,
  keyOf: prKeyToString,
  bindingsChangedEvent: 'prSubscriptionBindingsChanged',
});

export const repoSubscriptionRegistry = new StreamSubscriptionRegistry<
  RepoKey,
  RepoSubscribeInput
>({
  name: 'RepoStreamSubscriptionRegistry',
  source: SharedRepoPollingSource,
  keyOf: repoKeyToString,
  bindingsChangedEvent: 'repoSubscriptionBindingsChanged',
});

export const issueSubscriptionRegistry = new StreamSubscriptionRegistry<
  string,
  IssueKey
>({
  name: 'IssueStreamSubscriptionRegistry',
  source: SharedIssuePollingSource,
  keyOf: issueKeyToString,
  bindingsChangedEvent: 'issueSubscriptionBindingsChanged',
});
