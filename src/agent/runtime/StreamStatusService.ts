// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { StreamStatus } from '@common/constants/streamStatus';

// Internal imports
import { STREAM_STATUS, isActiveStatus } from '@common/constants/streamStatus';
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
   * Attempt to acquire a stream for execution.
   * Returns true if acquired (sets INITIALIZING), false if already active.
   *
   * This is an atomic check-and-set to prevent race conditions when launching
   * workflows concurrently. Blocks on RUNNING, RESUMING, INITIALIZING, and WAITING.
   *
   * WAITING is blocked because the stream is awaiting user action (e.g., retry
   * after 429 rate limit). Starting a new stream would interrupt the retry flow.
   */
  tryAcquire(stream: StreamTabId): boolean {
    const current = statusMemory.get(stream);

    // Block if already active (running/resuming), initializing, or waiting for retry
    if (
      current === STREAM_STATUS.RUNNING ||
      current === STREAM_STATUS.RESUMING ||
      current === STREAM_STATUS.INITIALIZING ||
      current === STREAM_STATUS.WAITING
    ) {
      return false;
    }

    // Acquire by setting INITIALIZING
    this.set(stream, STREAM_STATUS.INITIALIZING);
    return true;
  },

  /**
   * Release an INITIALIZING stream on error.
   * Only clears if current status is still INITIALIZING.
   */
  releaseIfInitializing(stream: StreamTabId): void {
    if (statusMemory.get(stream) === STREAM_STATUS.INITIALIZING) {
      this.clear(stream);
    }
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
      bus.emit('updateStreamStatus', {
        streamId: stream,
        status,
        previousStatus,
      });
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

  // ============================================================================
  // Guard Helpers - Centralized status checks for consistency
  // ============================================================================

  /**
   * Check if stream is actively processing (RUNNING or RESUMING).
   * Use to guard against concurrent operations.
   * Delegates to isActiveStatus() for the actual status check.
   */
  isActiveOrResuming(stream: StreamTabId): boolean {
    return isActiveStatus(statusMemory.get(stream));
  },

  /**
   * Check if stream status should be preserved on flow completion.
   * WAITING and STOPPED states shouldn't be overwritten by flow end status.
   */
  shouldPreserveOnCompletion(stream: StreamTabId): boolean {
    const status = statusMemory.get(stream);
    return status === STREAM_STATUS.WAITING || status === STREAM_STATUS.STOPPED;
  },

  /**
   * Check if a status transition might affect stream tab ordering.
   * First status assignment or transitions TO running may result in new log
   * activity that changes the stream's position in time-sorted order.
   */
  mightAffectTabOrder(
    previous: StreamStatus | undefined,
    current: StreamStatus,
  ): boolean {
    // First status assignment should always trigger refresh
    if (previous === undefined) {
      return true;
    }
    // Transitioning TO running may result in new log activity
    return (
      current === STREAM_STATUS.RUNNING && previous !== STREAM_STATUS.RUNNING
    );
  },
};
