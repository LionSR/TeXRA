// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { StreamStatus } from '@common/constants/streamStatus';

// Internal imports
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { bus } from '@eventBus/ProgressEventBus';

const statusMemory = new Map<StreamTabId, StreamStatus>();

/**
 * Single source of truth for stream status.
 * Maintains synchronous access for reads while emitting events for UI updates.
 */
export const StreamStatusService = {
  get(stream: StreamTabId): StreamStatus {
    return statusMemory.get(stream) ?? STREAM_STATUS.READY;
  },

  set(stream: StreamTabId, status: StreamStatus): void {
    if (status === STREAM_STATUS.READY) {
      statusMemory.delete(stream);
    } else {
      statusMemory.set(stream, status);
    }

    bus.emit('updateStreamStatus', { stream, status });
  },

  /**
   * Update status locally without emitting an event.
   * Used by ProgressEventHandler for batch updates during reload recovery.
   */
  setLocal(stream: StreamTabId, status: StreamStatus): void {
    if (status === STREAM_STATUS.READY) {
      statusMemory.delete(stream);
    } else {
      statusMemory.set(stream, status);
    }
  },

  clear(stream: StreamTabId): void {
    this.set(stream, STREAM_STATUS.READY);
  },

  /** Iterate over all stream statuses (for batch operations) */
  entries(): IterableIterator<[StreamTabId, StreamStatus]> {
    return statusMemory.entries();
  },

  /** Get a copy of all stream statuses */
  getAll(): Map<StreamTabId, StreamStatus> {
    return new Map(statusMemory);
  },

  /** Check if a stream has a status set */
  has(stream: StreamTabId): boolean {
    return statusMemory.has(stream);
  },
};
