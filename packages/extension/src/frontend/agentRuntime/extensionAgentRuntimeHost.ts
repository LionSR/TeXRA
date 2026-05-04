import { createAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressSink } from '@agent/runtime/ProgressSink';
import { bus } from '@eventBus/ProgressEventBus';

const extensionProgressSink: ProgressSink = {
  emit: (event, payload) => bus.emit(event, payload),
};

export const extensionAgentRuntimeHost = createAgentRuntimeHost(
  extensionProgressSink,
);
