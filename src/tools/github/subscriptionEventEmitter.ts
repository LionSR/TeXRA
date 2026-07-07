import { appSignals, type AppSignalPayloads } from '@eventBus/AppSignals';

export type GitHubSubscriptionChangedEvent =
  | 'prSubscriptionsChanged'
  | 'repoSubscriptionsChanged'
  | 'issueSubscriptionsChanged'
  | 'prSubscriptionBindingsChanged'
  | 'repoSubscriptionBindingsChanged'
  | 'issueSubscriptionBindingsChanged';

export function emitGitHubSubscriptionChanged<
  K extends GitHubSubscriptionChangedEvent,
>(event: K, payload: AppSignalPayloads[K]): void {
  appSignals.emit(event, payload);
}
