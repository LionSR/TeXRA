import type { StreamTabId } from '@shared/schemas';

import {
  issueKeyToString,
  issuePollingSource,
  type IssueKey,
} from './IssuePollingSource';
import {
  prKeyToString,
  prPollingSource,
  type PRSubscribeInput,
} from './PRPollingSource';
import {
  repoKeyOf,
  repoPollingSource,
  type RepoKey,
} from './RepoPollingSource';
import { StreamSubscriptionRegistry } from './StreamSubscriptionRegistry';

const prSubscriptions = new StreamSubscriptionRegistry<
  string,
  PRSubscribeInput
>({
  name: 'PRStreamSubscriptionRegistry',
  source: prPollingSource,
  keyOf: prKeyToString,
  bindingsChangedEvent: 'prSubscriptionBindingsChanged',
});

export interface PRSubscriptionBinding {
  key: string;
  streamIds: readonly StreamTabId[];
}

export function listPRSubscriptionBindings(
  keys: readonly string[] = prPollingSource.activeKeys(),
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

export interface RepoBindInput {
  owner: string;
  repo: string;
}

const repoSubscriptions = new StreamSubscriptionRegistry<
  RepoKey,
  RepoBindInput
>({
  name: 'RepoStreamSubscriptionRegistry',
  source: {
    has: (key) => repoPollingSource.has(key),
    activeKeys: () => repoPollingSource.activeKeys(),
    onKeysChanged: (listener) => repoPollingSource.onKeysChanged(listener),
    subscribe: (input, listener) =>
      repoPollingSource.subscribe(input.owner, input.repo, listener),
  },
  keyOf: (input) => repoKeyOf(input.owner, input.repo),
  bindingsChangedEvent: 'repoSubscriptionBindingsChanged',
});

export interface RepoSubscriptionBinding {
  key: RepoKey;
  streamIds: readonly StreamTabId[];
}

export function listRepoSubscriptionBindings(
  keys: readonly RepoKey[] = repoPollingSource.activeKeys(),
): RepoSubscriptionBinding[] {
  return repoSubscriptions.list(keys);
}

export function bindRepoSubscription(
  streamId: StreamTabId,
  input: RepoBindInput,
): boolean {
  return repoSubscriptions.bind(streamId, input);
}

export function unbindRepoSubscription(
  streamId: StreamTabId,
  input: RepoBindInput,
): boolean {
  return repoSubscriptions.unbind(streamId, input);
}

export function unbindAllForRepo(key: string): number {
  return repoSubscriptions.unbindAll(key);
}

const issueSubscriptions = new StreamSubscriptionRegistry<string, IssueKey>({
  name: 'IssueStreamSubscriptionRegistry',
  source: issuePollingSource,
  keyOf: issueKeyToString,
  bindingsChangedEvent: 'issueSubscriptionBindingsChanged',
});

export interface IssueSubscriptionBinding {
  key: string;
  streamIds: readonly StreamTabId[];
}

export function listIssueSubscriptionBindings(
  keys: readonly string[] = issuePollingSource.activeKeys(),
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
