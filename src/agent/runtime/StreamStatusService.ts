// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { StreamStatus } from '@common/constants/streamStatus';

// Internal imports
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { bus } from '@eventBus/ProgressEventBus';

const statusMemory = new Map<StreamTabId, StreamStatus>();

/** Options for setting stream status */
interface SetOptions {
  /**
   * Whether to emit an updateStreamStatus event.
   * Set to false when handling an event to avoid re-emission.
   * @default true
   */
  emit?: boolean;
}

/**
 * Single source of truth for stream status.
 * Maintains synchronous access for reads while emitting events for UI updates.
 */
export const StreamStatusService = {
  /**
   * Get the status for a stream.
   * @returns The stream's status, or undefined if no status has been set.
   */
  get(stream: StreamTabId): StreamStatus | undefined {
    return statusMemory.get(stream);
  },

  /**
   * Set the status for a stream.
   * @param stream - Stream identifier
   * @param status - New status (READY clears the status)
   * @param options - Set options
   * @param options.emit - Whether to emit event (default: true). Set false when
   *                       handling an event to avoid re-emission, or during batch
   *                       operations like reload recovery.
   */
  set(
    stream: StreamTabId,
    status: StreamStatus,
    options: SetOptions = {},
  ): void {
    const { emit = true } = options;

    // Capture previous status BEFORE mutation for event payload
    const previousStatus = statusMemory.get(stream) ?? STREAM_STATUS.READY;

    if (status === STREAM_STATUS.READY) {
      statusMemory.delete(stream);
    } else {
      statusMemory.set(stream, status);
    }

    if (emit) {
      bus.emit('updateStreamStatus', { stream, status, previousStatus });
    }
  },

  /** Clear a stream's status (sets to READY and emits event) */
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
