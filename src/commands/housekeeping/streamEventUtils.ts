import type { StreamConfig } from '@common/schemas';
import { bus } from '@eventBus/ProgressEventBus';
import { getStreamTabId } from '@logger/index';

export interface ClearMissingOutputsOptions {
  /** Stream configuration (agent/model/file) */
  streamConfig: StreamConfig;
  /** Whether agent uses multiple outputs */
  useMultipleOutputs: boolean;
  /** Override stream ID instead of deriving from config */
  streamIdOverride?: string;
}

export function emitClearMissingOutputs(
  options: ClearMissingOutputsOptions,
): void {
  const { streamConfig, useMultipleOutputs, streamIdOverride } = options;
  bus.emit('clearMissingOutputs', {
    streamId:
      streamIdOverride ||
      getStreamTabId(
        streamConfig.agent,
        streamConfig.model,
        streamConfig.inputFile,
        {
          useMultipleOutputs,
        },
      ),
  });
}
