import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
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
  runtimeHost: AgentRuntimeHost,
): boolean {
  return prSubscriptions.bind(streamId, pr, runtimeHost);
}

export function unbindPRSubscription(
  streamId: StreamTabId,
  pr: PRSubscribeInput,
  runtimeHost?: AgentRuntimeHost,
): boolean {
  return prSubscriptions.unbind(streamId, pr, runtimeHost);
}

export function unbindAllForPR(
  key: string,
  runtimeHost?: AgentRuntimeHost,
): number {
  return prSubscriptions.unbindAll(key, runtimeHost);
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
    subscribe: (input, listener, runtimeHost) =>
      repoPollingSource.subscribe(
        input.owner,
        input.repo,
        listener,
        runtimeHost,
      ),
    updateSubscription: (input, listener, runtimeHost) =>
      repoPollingSource.updateListenerRuntimeHost(
        repoKeyOf(input.owner, input.repo),
        listener,
        runtimeHost,
      ),
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
  runtimeHost: AgentRuntimeHost,
): boolean {
  return repoSubscriptions.bind(streamId, input, runtimeHost);
}

export function unbindRepoSubscription(
  streamId: StreamTabId,
  input: RepoBindInput,
  runtimeHost?: AgentRuntimeHost,
): boolean {
  return repoSubscriptions.unbind(streamId, input, runtimeHost);
}

export function unbindAllForRepo(
  key: string,
  runtimeHost?: AgentRuntimeHost,
): number {
  return repoSubscriptions.unbindAll(key, runtimeHost);
}

const issueSubscriptions = new StreamSubscriptionRegistry<string, IssueKey>({
  name: 'IssueStreamSubscriptionRegistry',
  source: {
    has: (key) => issuePollingSource.has(key),
    activeKeys: () => issuePollingSource.activeKeys(),
    onKeysChanged: (listener) => issuePollingSource.onKeysChanged(listener),
    subscribe: (input, listener, runtimeHost) =>
      issuePollingSource.subscribe(input, listener, runtimeHost),
    updateSubscription: (input, listener, runtimeHost) =>
      issuePollingSource.updateListenerRuntimeHost(
        issueKeyToString(input),
        listener,
        runtimeHost,
      ),
  },
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
  runtimeHost: AgentRuntimeHost,
): boolean {
  return issueSubscriptions.bind(streamId, issue, runtimeHost);
}

export function unbindIssueSubscription(
  streamId: StreamTabId,
  issue: IssueKey,
  runtimeHost?: AgentRuntimeHost,
): boolean {
  return issueSubscriptions.unbind(streamId, issue, runtimeHost);
}

export function unbindAllForIssue(
  key: string,
  runtimeHost?: AgentRuntimeHost,
): number {
  return issueSubscriptions.unbindAll(key, runtimeHost);
}
