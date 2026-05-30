import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

export interface AgentRuntimeHost {
  emit<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}

export const noopAgentRuntimeHost: AgentRuntimeHost = {
  emit: () => {},
};
