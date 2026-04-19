import { bus } from '@eventBus/ProgressEventBus';

export interface ClearMissingOutputsOptions {
  /** Clear missing-outputs marker for a specific stream tab. */
  streamIdOverride?: string;
  /**
   * Clear missing-outputs marker across every workflow tab whose taskState
   * matches this config. Used by command-palette pack/clean which has no
   * stream context — multiple workflow tabs can exist for the same agent
   * + model + inputFile combination after the one-run-per-tab refactor.
   * Supply `useMultipleOutputs` to narrow the match so tabs with a
   * different output shape on the same input aren't cleared together.
   */
  streamConfig?: {
    agent: string;
    model: string;
    inputFile: string;
    useMultipleOutputs?: boolean;
  };
}

export function emitClearMissingOutputs(
  options: ClearMissingOutputsOptions,
): void {
  if (options.streamIdOverride) {
    bus.emit('clearMissingOutputs', { streamId: options.streamIdOverride });
    return;
  }
  if (options.streamConfig) {
    bus.emit('clearMissingOutputs', { streamConfig: options.streamConfig });
  }
}
