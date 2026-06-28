import type { StreamStatus, StreamTabId } from '@shared/schemas';

export interface ProgressRuntimeStatus {
  getSnapshot(): Map<StreamTabId, StreamStatus>;
  setSilently(streamId: StreamTabId, status: StreamStatus): void;
  clear(streamId: StreamTabId): void;
  clearAll(): void;
  isInFlight(streamId: StreamTabId): boolean;
  markRunningStopped(): void;
}

export interface ProgressRunningStreamRecovery {
  readonly waitingStreams: readonly StreamTabId[];
  readonly erroredStreams: readonly StreamTabId[];
}

export const defaultProgressRuntimeStatus: ProgressRuntimeStatus = {
  getSnapshot: () => new Map(),
  setSilently: () => undefined,
  clear: () => undefined,
  clearAll: () => undefined,
  isInFlight: () => false,
  markRunningStopped: () => undefined,
};
