import { bus } from '@eventBus/ProgressEventBus';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';

export const extensionAgentRuntimeHost: AgentRuntimeHost = {
  emit: (event, payload) => bus.emit(event, payload),
};
