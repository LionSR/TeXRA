import { defaultSession } from '@agent/runtime/SessionHandle';

/**
 * Identity of a pack/clean operation, as far as the missing-outputs marker is
 * concerned. Structurally satisfied by both `PackConfig` and `CleanConfig`.
 */
interface FileOpTarget {
  agent: string;
  model: string;
  inputFile: string;
  outputFiles: readonly string[];
  /** Toolbar invocations target one tab; palette invocations have none. */
  streamId?: string;
  skipProgressViewClear?: boolean;
}

/**
 * Clear the missing-outputs marker for the workflow tab(s) a pack/clean
 * operation touched. With a `streamId` the marker is cleared on that tab
 * alone; without one it is broadcast to every workflow tab whose taskState
 * matches the agent/model/inputFile identity.
 */
export function emitClearMissingOutputs(target: FileOpTarget): void {
  if (target.skipProgressViewClear) return;
  const { agent, model, inputFile, outputFiles, streamId } = target;
  defaultSession().events.emit({
    scope: 'session',
    event: {
      type: 'clearMissingOutputs',
      payload: streamId
        ? { streamId }
        : { streamConfig: { agent, model, inputFile, outputFiles } },
    },
  });
}
