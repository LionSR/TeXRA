/**
 * Repo-flavored thin wrapper over the generic `SubscriptionBinder`.
 */

import type { StreamTabId } from '@shared/schemas';

import {
  repoKeyOf,
  repoPollingSource,
  type RepoKey,
} from './RepoPollingSource';
import { SubscriptionBinder } from './SubscriptionBinder';

export interface RepoBindInput {
  owner: string;
  repo: string;
}

const binder = new SubscriptionBinder<RepoKey, RepoBindInput>({
  name: 'RepoSubscriptionBinder',
  source: {
    has: (key) => repoPollingSource.has(key),
    activeKeys: () => repoPollingSource.activeKeys(),
    subscribe: (input, listener) =>
      repoPollingSource.subscribe(input.owner, input.repo, listener),
  },
  keyOf: (input) => repoKeyOf(input.owner, input.repo),
  sourceKeysChangedEvent: 'repoSubscriptionsChanged',
  bindingsChangedEvent: 'repoSubscriptionBindingsChanged',
});

export interface RepoSubscriptionBinding {
  key: RepoKey;
  streamIds: readonly StreamTabId[];
}

export function listRepoSubscriptionBindings(
  keys: readonly RepoKey[] = repoPollingSource.activeKeys(),
): RepoSubscriptionBinding[] {
  return binder.list(keys);
}

export function bindRepoSubscription(
  streamId: StreamTabId,
  input: RepoBindInput,
): boolean {
  return binder.bind(streamId, input);
}

export function unbindRepoSubscription(
  streamId: StreamTabId,
  input: RepoBindInput,
): boolean {
  return binder.unbind(streamId, input);
}

export function unbindAllForRepo(key: string): number {
  return binder.unbindAll(key);
}
