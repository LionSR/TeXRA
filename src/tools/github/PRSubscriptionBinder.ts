/**
 * PR-flavored thin wrapper over the generic `SubscriptionBinder`. Preserves
 * the existing function-based public API (`bindPRSubscription` etc.) so
 * callers don't change.
 */

import type { StreamTabId } from '@shared/schemas';

import { prKeyToString, prPollingSource, type PRKey } from './PRPollingSource';
import { SubscriptionBinder } from './SubscriptionBinder';

const binder = new SubscriptionBinder<string, PRKey>({
  name: 'PRSubscriptionBinder',
  source: prPollingSource,
  keyOf: prKeyToString,
  sourceKeysChangedEvent: 'prSubscriptionsChanged',
  bindingsChangedEvent: 'prSubscriptionBindingsChanged',
});

export interface PRSubscriptionBinding {
  key: string;
  streamIds: readonly StreamTabId[];
}

export function listPRSubscriptionBindings(
  keys: readonly string[] = prPollingSource.activeKeys(),
): PRSubscriptionBinding[] {
  return binder.list(keys);
}

export function bindPRSubscription(streamId: StreamTabId, pr: PRKey): boolean {
  return binder.bind(streamId, pr);
}

export function unbindPRSubscription(
  streamId: StreamTabId,
  pr: PRKey,
): boolean {
  return binder.unbind(streamId, pr);
}

export function unbindAllForPR(key: string): number {
  return binder.unbindAll(key);
}
