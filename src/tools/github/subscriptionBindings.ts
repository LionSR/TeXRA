import type { StreamTabId } from '@shared/schemas';

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
import {
  StreamSubscriptionRegistry,
  type SubscriptionBinding,
} from './StreamSubscriptionRegistry';

const prSubscriptions = new StreamSubscriptionRegistry<
  string,
  PRSubscribeInput
>({
  name: 'PRStreamSubscriptionRegistry',
  source: SharedPRPollingSource,
  keyOf: prKeyToString,
  bindingsChangedEvent: 'prSubscriptionBindingsChanged',
});

export type PRSubscriptionBinding = SubscriptionBinding<string>;

export function listPRSubscriptionBindings(
  keys: readonly string[] = SharedPRPollingSource.activeKeys(),
): PRSubscriptionBinding[] {
  return prSubscriptions.list(keys);
}

export function bindPRSubscription(
  streamId: StreamTabId,
  pr: PRSubscribeInput,
): boolean {
  return prSubscriptions.bind(streamId, pr);
}

export function unbindPRSubscription(
  streamId: StreamTabId,
  pr: PRSubscribeInput,
): boolean {
  return prSubscriptions.unbind(streamId, pr);
}

export function unbindAllForPR(key: string): number {
  return prSubscriptions.unbindAll(key);
}

const repoSubscriptions = new StreamSubscriptionRegistry<
  RepoKey,
  RepoSubscribeInput
>({
  name: 'RepoStreamSubscriptionRegistry',
  source: SharedRepoPollingSource,
  keyOf: repoKeyToString,
  bindingsChangedEvent: 'repoSubscriptionBindingsChanged',
});

export type RepoSubscriptionBinding = SubscriptionBinding<RepoKey>;

export function listRepoSubscriptionBindings(
  keys: readonly RepoKey[] = SharedRepoPollingSource.activeKeys(),
): RepoSubscriptionBinding[] {
  return repoSubscriptions.list(keys);
}

export function bindRepoSubscription(
  streamId: StreamTabId,
  input: RepoSubscribeInput,
): boolean {
  return repoSubscriptions.bind(streamId, input);
}

export function unbindRepoSubscription(
  streamId: StreamTabId,
  input: RepoSubscribeInput,
): boolean {
  return repoSubscriptions.unbind(streamId, input);
}

export function unbindAllForRepo(key: string): number {
  return repoSubscriptions.unbindAll(key);
}

const issueSubscriptions = new StreamSubscriptionRegistry<string, IssueKey>({
  name: 'IssueStreamSubscriptionRegistry',
  source: SharedIssuePollingSource,
  keyOf: issueKeyToString,
  bindingsChangedEvent: 'issueSubscriptionBindingsChanged',
});

export type IssueSubscriptionBinding = SubscriptionBinding<string>;

export function listIssueSubscriptionBindings(
  keys: readonly string[] = SharedIssuePollingSource.activeKeys(),
): IssueSubscriptionBinding[] {
  return issueSubscriptions.list(keys);
}

export function bindIssueSubscription(
  streamId: StreamTabId,
  issue: IssueKey,
): boolean {
  return issueSubscriptions.bind(streamId, issue);
}

export function unbindIssueSubscription(
  streamId: StreamTabId,
  issue: IssueKey,
): boolean {
  return issueSubscriptions.unbind(streamId, issue);
}

export function unbindAllForIssue(key: string): number {
  return issueSubscriptions.unbindAll(key);
}
