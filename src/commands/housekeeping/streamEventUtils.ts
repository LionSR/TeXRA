import { bus } from '@eventBus/ProgressEventBus';

export interface ClearMissingOutputsOptions {
  /** Stream ID of the tab whose missing-outputs marker should be cleared. */
  streamIdOverride?: string;
}

/**
 * Clear the "missing outputs" marker for a specific stream tab.
 * Each run now has a unique stream tab ID, so a stream ID must be provided
 * — there's no way to derive one from config alone (the executionId is
 * required for uniqueness).
 */
export function emitClearMissingOutputs(
  options: ClearMissingOutputsOptions,
): void {
  if (!options.streamIdOverride) return;
  bus.emit('clearMissingOutputs', { streamId: options.streamIdOverride });
}
