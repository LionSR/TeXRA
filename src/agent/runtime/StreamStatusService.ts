// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { StreamStatus } from '@common/constants/streamStatus';

// Internal imports
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { bus } from '@eventBus/ProgressEventBus';

const statusMemory = new Map<StreamTabId, StreamStatus>();

/**
 * Single source of truth for stream status.
 *
 * All status reads should go through this service. The ProgressEventHandler
 * subscribes to updateStreamStatus events to update the webview.
 */
export const StreamStatusService = {
  get(stream: StreamTabId): StreamStatus {
    return statusMemory.get(stream) ?? STREAM_STATUS.READY;
  },

  /**
   * Get all stream statuses. Returns a copy to prevent external mutation.
   */
  getAll(): Map<StreamTabId, StreamStatus> {
    return new Map(statusMemory);
  },

  /**
   * Set stream status and emit event to notify listeners.
   */
  set(stream: StreamTabId, status: StreamStatus): void {
    if (status === STREAM_STATUS.READY) {
      statusMemory.delete(stream);
    } else {
      statusMemory.set(stream, status);
    }

    bus.emit('updateStreamStatus', { stream, status });
  },

  /**
   * Update status without emitting an event.
   * Use this when updating from UI layer to avoid event loops.
   */
  setQuiet(stream: StreamTabId, status: StreamStatus): void {
    if (status === STREAM_STATUS.READY) {
      statusMemory.delete(stream);
    } else {
      statusMemory.set(stream, status);
    }
  },

  clear(stream: StreamTabId): void {
    this.set(stream, STREAM_STATUS.READY);
  },
};
