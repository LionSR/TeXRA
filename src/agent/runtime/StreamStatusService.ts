import {
  isActiveStatus,
  isInFlightStatus,
} from '@common/constants/streamStatus';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  STREAM_STATUS,
  type ExecutionStatus,
  type StreamTabId,
  type StreamStatus,
} from '@shared/schemas';

export interface StreamStatusChange {
  streamId: StreamTabId;
  status: StreamStatus;
  previousStatus: StreamStatus;
  terminalStatus?: ExecutionStatus;
}

interface EmitSetOptions {
  emit?: true;
  runtimeHost: AgentRuntimeHost;
  terminalStatus?: ExecutionStatus;
}

interface SilentSetOptions {
  emit: false;
  runtimeHost?: AgentRuntimeHost;
  terminalStatus?: ExecutionStatus;
}

type SetOptions = EmitSetOptions | SilentSetOptions;

export class StreamStatusRegistry {
  private readonly statusMemory = new Map<StreamTabId, StreamStatus>();
  private readonly statusListeners = new Set<
    (change: StreamStatusChange) => void
  >();

  get(stream: StreamTabId): StreamStatus | undefined {
    return this.statusMemory.get(stream);
  }

  tryAcquire(stream: StreamTabId, options: SetOptions): boolean {
    if (isInFlightStatus(this.statusMemory.get(stream))) {
      return false;
    }
    this.set(stream, STREAM_STATUS.INITIALIZING, options);
    return true;
  }

  releaseIfInitializing(stream: StreamTabId, options: SetOptions): void {
    if (this.statusMemory.get(stream) === STREAM_STATUS.INITIALIZING) {
      this.clear(stream, options);
    }
  }

  set(stream: StreamTabId, status: StreamStatus, options: SetOptions): void {
    const previousStatus = this.statusMemory.get(stream) ?? STREAM_STATUS.READY;

    if (status === STREAM_STATUS.READY) {
      this.statusMemory.delete(stream);
    } else {
      this.statusMemory.set(stream, status);
    }

    if (options.emit !== false) {
      const change: StreamStatusChange = {
        streamId: stream,
        status,
        previousStatus,
        ...(options.terminalStatus
          ? { terminalStatus: options.terminalStatus }
          : {}),
      };
      options.runtimeHost.emit('updateStreamStatus', change);
      for (const listener of this.statusListeners) {
        listener(change);
      }
    }
  }

  clear(stream: StreamTabId, options: SetOptions): void {
    this.set(stream, STREAM_STATUS.READY, options);
  }

  /** Reset every stream to READY. Used by ProgressViewState.clearAll(). */
  clearAll(options: SetOptions): void {
    for (const stream of [...this.statusMemory.keys()]) {
      this.clear(stream, options);
    }
  }

  entries(): IterableIterator<[StreamTabId, StreamStatus]> {
    return this.statusMemory.entries();
  }

  getAll(): Map<StreamTabId, StreamStatus> {
    return new Map(this.statusMemory);
  }

  has(stream: StreamTabId): boolean {
    return this.statusMemory.has(stream);
  }

  isActiveOrResuming(stream: StreamTabId): boolean {
    return isActiveStatus(this.statusMemory.get(stream));
  }

  shouldPreserveOnCompletion(stream: StreamTabId): boolean {
    const status = this.statusMemory.get(stream);
    return status === STREAM_STATUS.WAITING || status === STREAM_STATUS.STOPPED;
  }

  onDidChange(listener: (change: StreamStatusChange) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
}

export const StreamStatusService = new StreamStatusRegistry();
