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

/**
 * Install the ambient runtime host. Only retained for legacy singleton
 * coordinators (`planApprovalCoordinator`, `proposalCoordinator`,
 * `retryCoordinator`) which use `getDefaultAgentRuntimeHost` as a lazy
 * lookup. New code must pass an explicit host to `executeAgent` and to
 * coordinator constructors — do not reach for this global.
 */
export function setDefaultAgentRuntimeHost(host: AgentRuntimeHost): void {
  defaultAgentRuntimeHost = host;
}

export function getDefaultAgentRuntimeHost(): AgentRuntimeHost {
  return defaultAgentRuntimeHost;
}
