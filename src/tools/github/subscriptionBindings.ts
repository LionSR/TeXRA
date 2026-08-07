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
  type StreamSubscriptionRegistryOptions,
  type SubscriptionBinding,
} from './StreamSubscriptionRegistry';

/**
 * Wire one polling source to a registry and expose its four operations as
 * plain functions. `list` takes optional keys so the no-arg default stays
 * owned by `StreamSubscriptionRegistry.list` (source.activeKeys()).
 */
function createSubscriptionBindings<K extends string, I>(
  opts: StreamSubscriptionRegistryOptions<K, I>,
): {
  list: (keys?: readonly K[]) => SubscriptionBinding<K>[];
  bind: (streamId: StreamTabId, input: I) => boolean;
  unbind: (streamId: StreamTabId, input: I) => boolean;
  unbindAll: (key: string) => number;
} {
  const registry = new StreamSubscriptionRegistry<K, I>(opts);
  return {
    list: (keys) => registry.list(keys),
    bind: (streamId, input) => registry.bind(streamId, input),
    unbind: (streamId, input) => registry.unbind(streamId, input),
    unbindAll: (key) => registry.unbindAll(key),
  };
}

export const {
  list: listPRSubscriptionBindings,
  bind: bindPRSubscription,
  unbind: unbindPRSubscription,
  unbindAll: unbindAllForPR,
} = createSubscriptionBindings<string, PRSubscribeInput>({
  name: 'PRStreamSubscriptionRegistry',
  source: SharedPRPollingSource,
  keyOf: prKeyToString,
  bindingsChangedEvent: 'prSubscriptionBindingsChanged',
});

export const {
  list: listRepoSubscriptionBindings,
  bind: bindRepoSubscription,
  unbind: unbindRepoSubscription,
  unbindAll: unbindAllForRepo,
} = createSubscriptionBindings<RepoKey, RepoSubscribeInput>({
  name: 'RepoStreamSubscriptionRegistry',
  source: SharedRepoPollingSource,
  keyOf: repoKeyToString,
  bindingsChangedEvent: 'repoSubscriptionBindingsChanged',
});

export const {
  list: listIssueSubscriptionBindings,
  bind: bindIssueSubscription,
  unbind: unbindIssueSubscription,
  unbindAll: unbindAllForIssue,
} = createSubscriptionBindings<string, IssueKey>({
  name: 'IssueStreamSubscriptionRegistry',
  source: SharedIssuePollingSource,
  keyOf: issueKeyToString,
  bindingsChangedEvent: 'issueSubscriptionBindingsChanged',
});
