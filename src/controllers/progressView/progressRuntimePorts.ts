import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  clearAllRuntimeStreamStatuses,
  clearRuntimeStreamStatus,
  getRuntimeStreamStatus,
  getRuntimeStreamStatusSnapshot,
  isRuntimeStreamInFlight,
  markRuntimeRunningStreamsStopped,
  setRuntimeStreamStatusSilently,
} from '@agent/runtime/streamControl';
import type { StreamStatus, StreamTabId } from '@shared/schemas';
import type { ProgressRuntimeSession } from '@shared/progressView/backend/runtimeSession';
import type { ProgressRuntimeStatus } from '@shared/progressView/backend/runtimeStatus';

export interface ProgressRuntimeStatusPort extends ProgressRuntimeStatus {
  get(streamId: StreamTabId): StreamStatus | undefined;
}

/**
 * Build the runtime-status port consumed by shared progress backends.
 *
 * Hosts should pass this port into progress composition instead of reassembling
 * stream-status internals locally. This keeps progress surfaces dependent on a
 * single host-neutral capability shape.
 */
export function createProgressRuntimeStatusPort(): ProgressRuntimeStatusPort {
  return {
    get: getRuntimeStreamStatus,
    getSnapshot: getRuntimeStreamStatusSnapshot,
    setSilently: setRuntimeStreamStatusSilently,
    clear: clearRuntimeStreamStatus,
    clearAll: clearAllRuntimeStreamStatuses,
    isInFlight: isRuntimeStreamInFlight,
    markRunningStopped: markRuntimeRunningStreamsStopped,
  };
}

/**
 * Build the session-scoped runtime port consumed by shared progress state.
 */
export function createProgressRuntimeSessionPort(
  session: SessionHandle,
): ProgressRuntimeSession {
  return {
    retainInterruptStreams: (streams) =>
      session.interrupts.retainOnly(new Set(streams)),
    flushPendingTraces: () => session.flushPendingTraces(),
  };
}
