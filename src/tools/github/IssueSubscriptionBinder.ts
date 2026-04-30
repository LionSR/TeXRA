/**
 * Issue-flavored thin wrapper over the generic `SubscriptionBinder`.
 */

import type { StreamTabId } from '@shared/schemas';

import {
  issueKeyToString,
  issuePollingSource,
  type IssueKey,
} from './IssuePollingSource';
import { SubscriptionBinder } from './SubscriptionBinder';

const binder = new SubscriptionBinder<string, IssueKey>({
  name: 'IssueSubscriptionBinder',
  source: issuePollingSource,
  keyOf: issueKeyToString,
  sourceKeysChangedEvent: 'issueSubscriptionsChanged',
  bindingsChangedEvent: 'issueSubscriptionBindingsChanged',
});

export interface IssueSubscriptionBinding {
  key: string;
  streamIds: readonly StreamTabId[];
}

export function listIssueSubscriptionBindings(
  keys: readonly string[] = issuePollingSource.activeKeys(),
): IssueSubscriptionBinding[] {
  return binder.list(keys);
}

export function bindIssueSubscription(
  streamId: StreamTabId,
  issue: IssueKey,
): boolean {
  return binder.bind(streamId, issue);
}

export function unbindIssueSubscription(
  streamId: StreamTabId,
  issue: IssueKey,
): boolean {
  return binder.unbind(streamId, issue);
}

export function unbindAllForIssue(key: string): number {
  return binder.unbindAll(key);
}
