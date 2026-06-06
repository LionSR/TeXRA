// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { StreamTabId } from '@shared/schemas';
import type { ProgressViewInboundHandlerRegistry } from '@shared/schemas/progressView';

export interface ProgressViewRunCommandActions {
  resumeStream(stream: StreamTabId): Promise<void> | void;
  runNewStream(stream: StreamTabId): Promise<void> | void;
}

export function createProgressViewRunCommandHandlers(
  actions: ProgressViewRunCommandActions,
): ProgressViewInboundHandlerRegistry {
  return {
    [PROGRESS_VIEW_COMMANDS.RESUME]: (data) =>
      actions.resumeStream(data.stream),
    [PROGRESS_VIEW_COMMANDS.RUN_NEW]: (data) =>
      actions.runNewStream(data.stream),
  };
}
