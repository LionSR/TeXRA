/** Per-run trace. Transcript history is folded from committed session events. */
import { TraceEmitter, type AgentTrace } from '@agent/trace';

export interface RunTrace {
  readonly trace: AgentTrace;
  readonly dispose: () => void;
}

/**
 * Open a run's trace and own the caller's transcript residency lease.
 *
 * The trace gets no diagnostic-channel subscriber, so the run needs no run id
 * here: its log events reach the durable transcript through
 * `SessionHandle.attachRunTrace`, which every host renders. A per-run output
 * channel would duplicate them into a surface keyed by an opaque run id,
 * created and disposed once per run.
 */
export function createRunTrace(residency?: {
  readonly close: () => void;
}): RunTrace {
  let disposed = false;
  return {
    trace: new TraceEmitter(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      residency?.close();
    },
  };
}
