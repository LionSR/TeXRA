import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { bus } from '@eventBus/ProgressEventBus';

export const extensionAgentRuntimeHost: AgentRuntimeHost = {
  emit: (event, payload) => bus.emit(event, payload),
};
