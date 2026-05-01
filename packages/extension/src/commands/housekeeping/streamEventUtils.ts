import { bus } from '@eventBus/ProgressEventBus';

/**
 * How to identify the workflow tab(s) whose missing-outputs marker should be
 * cleared. Exactly one strategy must be specified:
 * - `streamIdOverride` targets one specific tab (toolbar invocations).
 * - `streamConfig` broadcasts to every workflow tab whose taskState matches
 *   the given agent/model/inputFile (command-palette invocations).
 */
export type ClearMissingOutputsOptions =
  | { streamIdOverride: string; streamConfig?: undefined }
  | {
      streamIdOverride?: undefined;
      streamConfig: {
        agent: string;
        model: string;
        inputFile: string;
      };
    };

export function emitClearMissingOutputs(
  options: ClearMissingOutputsOptions,
): void {
  if (options.streamIdOverride !== undefined) {
    bus.emit('clearMissingOutputs', { streamId: options.streamIdOverride });
    return;
  }
  bus.emit('clearMissingOutputs', { streamConfig: options.streamConfig });
}
