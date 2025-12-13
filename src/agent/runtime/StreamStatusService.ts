// Type imports
import { STREAM_STATUS } from '@shared/status';
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@shared/identifiers';
import type { StreamStatus } from '@shared/status';

// Internal imports

const statusMemory = new Map<StreamTabId, StreamStatus>();

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

  clear(stream: StreamTabId): void {
    this.set(stream, STREAM_STATUS.READY);
  },
};
