/** Per-run channel output. Transcript history is folded from committed session events. */
import {
  attachChannelSubscriber,
  TraceEmitter,
  type AgentTrace,
} from '@agent/trace';
import type { StreamTabId } from '@shared/schemas';
import { aggregateError } from '@utils/core';

export interface RunTrace {
  readonly trace: AgentTrace;
  readonly dispose: () => void;
}

/** Run every resource release and preserve all failures. */
function releaseAll(actions: readonly (() => void)[]): void {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw aggregateError(failures, 'Run trace cleanup failed');
}

/** Attach channel output and own the caller's transcript residency lease. */
export function createRunTrace(
  streamId: StreamTabId,
  residency?: { readonly close: () => void },
): RunTrace {
  const trace = new TraceEmitter();
  let unsubscribeChannel: () => void;
  try {
    unsubscribeChannel = attachChannelSubscriber(trace, {
      channel: streamId,
      isAgent: true,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      residency?.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    throw aggregateError(failures, 'Run trace setup and cleanup failed');
  }
  let disposed = false;
  return {
    trace,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      releaseAll([unsubscribeChannel, () => residency?.close()]);
    },
  };
}
