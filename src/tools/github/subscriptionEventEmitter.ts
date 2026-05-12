import {
  getAgentRuntimeHost,
  getDefaultAgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { bus, type ProgressEventPayloads } from '@eventBus/ProgressEventBus';

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
  bus.emit(event, payload);

  const runtimeHost = getAgentRuntimeHost();
  if (runtimeHost !== getDefaultAgentRuntimeHost()) {
    runtimeHost.emit(event, payload);
  }
}
