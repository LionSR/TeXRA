// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import type { StreamStatus } from '@common/constants/streamStatus';

// Internal imports
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { bus } from '@eventBus/ProgressEventBus';

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
