import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';

export type GitHubSubscriptionChangedEvent =
  | 'prSubscriptionsChanged'
  | 'repoSubscriptionsChanged'
  | 'issueSubscriptionsChanged'
  | 'prSubscriptionBindingsChanged'
  | 'repoSubscriptionBindingsChanged'
  | 'issueSubscriptionBindingsChanged';

export function emitGitHubSubscriptionChanged<
  K extends GitHubSubscriptionChangedEvent,
>(
  runtimeHost: AgentRuntimeHost,
  event: K,
  payload: ProgressEventPayloads[K],
): void {
  runtimeHost.emit(event, payload);
}

export function emitGitHubSubscriptionChangedToHosts<
  K extends GitHubSubscriptionChangedEvent,
>(
  runtimeHosts: Iterable<AgentRuntimeHost>,
  event: K,
  payload: ProgressEventPayloads[K],
): void {
  for (const runtimeHost of new Set(runtimeHosts)) {
    emitGitHubSubscriptionChanged(runtimeHost, event, payload);
  }
}
