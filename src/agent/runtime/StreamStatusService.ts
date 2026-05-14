import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  isActiveStatus,
  isInFlightStatus,
} from '@common/constants/streamStatus';
import {
  STREAM_STATUS,
  type StreamTabId,
  type StreamStatus,
} from '@shared/schemas';

const statusMemory = new Map<StreamTabId, StreamStatus>();
const statusListeners = new Set<(change: StreamStatusChange) => void>();

export interface StreamStatusChange {
  streamId: StreamTabId;
  status: StreamStatus;
  previousStatus: StreamStatus;
}

interface EmitSetOptions {
  emit?: true;
  runtimeHost: AgentRuntimeHost;
}

interface SilentSetOptions {
  emit: false;
  runtimeHost?: AgentRuntimeHost;
}

type SetOptions = EmitSetOptions | SilentSetOptions;

export const StreamStatusService = {
  get(stream: StreamTabId): StreamStatus | undefined {
    return statusMemory.get(stream);
  },

  tryAcquire(stream: StreamTabId, options: SetOptions): boolean {
    if (isInFlightStatus(statusMemory.get(stream))) {
      return false;
    }
    this.set(stream, STREAM_STATUS.INITIALIZING, options);
    return true;
  },

  releaseIfInitializing(stream: StreamTabId, options: SetOptions): void {
    if (statusMemory.get(stream) === STREAM_STATUS.INITIALIZING) {
      this.clear(stream, options);
    }
  },

  set(stream: StreamTabId, status: StreamStatus, options: SetOptions): void {
    const previousStatus = statusMemory.get(stream) ?? STREAM_STATUS.READY;

    if (status === STREAM_STATUS.READY) {
      statusMemory.delete(stream);
    } else {
      statusMemory.set(stream, status);
    }

    if (options.emit !== false) {
      const change: StreamStatusChange = {
        streamId: stream,
        status,
        previousStatus,
      };
      options.runtimeHost.emit('updateStreamStatus', change);
      for (const listener of statusListeners) {
        listener(change);
      }
    }
  },

  clear(stream: StreamTabId, options: SetOptions): void {
    this.set(stream, STREAM_STATUS.READY, options);
  },

  /** Reset every stream to READY. Used by ProgressViewState.clearAll(). */
  clearAll(options: SetOptions): void {
    for (const stream of [...statusMemory.keys()]) {
      this.clear(stream, options);
    }
  },

  entries(): IterableIterator<[StreamTabId, StreamStatus]> {
    return statusMemory.entries();
  },

  getAll(): Map<StreamTabId, StreamStatus> {
    return new Map(statusMemory);
  },

  has(stream: StreamTabId): boolean {
    return statusMemory.has(stream);
  },

  isActiveOrResuming(stream: StreamTabId): boolean {
    return isActiveStatus(statusMemory.get(stream));
  },

  shouldPreserveOnCompletion(stream: StreamTabId): boolean {
    const status = statusMemory.get(stream);
    return status === STREAM_STATUS.WAITING || status === STREAM_STATUS.STOPPED;
  },

  onDidChange(listener: (change: StreamStatusChange) => void): () => void {
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  },
};
