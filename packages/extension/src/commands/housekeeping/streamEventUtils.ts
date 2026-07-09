import { defaultSession } from '@agent/runtime/SessionHandle';

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
        outputFiles?: readonly string[];
      };
    };

export function emitClearMissingOutputs(
  options: ClearMissingOutputsOptions,
): void {
  if (options.streamIdOverride !== undefined) {
    defaultSession().events.emit({
      scope: 'session',
      event: {
        type: 'clearMissingOutputs',
        payload: { streamId: options.streamIdOverride },
      },
    });
    return;
  }
  defaultSession().events.emit({
    scope: 'session',
    event: {
      type: 'clearMissingOutputs',
      payload: { streamConfig: options.streamConfig },
    },
  });
}
