import { getAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

export type GitHubSubscriptionChangedEvent =
  | 'prSubscriptionsChanged'
  | 'repoSubscriptionsChanged'
  | 'issueSubscriptionsChanged'
  | 'prSubscriptionBindingsChanged'
  | 'repoSubscriptionBindingsChanged'
  | 'issueSubscriptionBindingsChanged';

export function emitGitHubSubscriptionChanged<
  K extends GitHubSubscriptionChangedEvent,
>(event: K, payload: ProgressEventPayloads[K]): void {
  getAgentRuntimeHost().emit(event, payload);
}
