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

let defaultAgentRuntimeHost: AgentRuntimeHost = noopAgentRuntimeHost;

export function setDefaultAgentRuntimeHost(host: AgentRuntimeHost): void {
  defaultAgentRuntimeHost = host;
}

export function getDefaultAgentRuntimeHost(): AgentRuntimeHost {
  return defaultAgentRuntimeHost;
}
