import type { StreamConfig } from '@common/schemas';
import { getStreamTabId } from '@logger/index';
import { bus } from '@eventBus/ProgressEventBus';

export interface ClearMissingOutputsOptions {
  /** Stream configuration (agent/model/file) */
  streamConfig: StreamConfig;
  /** Whether agent uses multiple outputs */
  useMultipleOutputs: boolean;
  /** Override stream ID instead of deriving from config */
  streamIdOverride?: string;
}

/**
 * Emit clearMissingOutputs event to update the progress view.
 * Used after pack/clean operations to clear missing output indicators.
 */
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
