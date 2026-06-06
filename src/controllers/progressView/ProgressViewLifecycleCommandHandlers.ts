// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategoryFilter, StreamTabId } from '@shared/schemas';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';

export interface ProgressViewLifecycleCommandActions {
  setActiveStream(stream: StreamTabId): Promise<void> | void;
  setAgentFilter(filter: AgentCategoryFilter): Promise<void> | void;
  deleteStream(stream: StreamTabId): Promise<void> | void;
  deleteAllStreams(): Promise<void> | void;
  stopStream(stream: StreamTabId): Promise<void> | void;
}

export function createProgressViewLifecycleCommandHandlers(
  actions: ProgressViewLifecycleCommandActions,
): ProgressViewInboundHandlerRegistry {
  return {
    [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: (data) =>
      actions.setActiveStream(data.stream),
    [PROGRESS_VIEW_COMMANDS.FILTER_STREAMS]: (data) =>
      actions.setAgentFilter(data.filter),
    [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (data) =>
      actions.deleteStream(data.stream),
    [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () => actions.deleteAllStreams(),
    [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: (data) =>
      actions.stopStream(data.stream),
  };
}
