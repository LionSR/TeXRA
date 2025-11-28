// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { STREAM_STATUS } from '@common/constants/streamStatus';
import { bus } from '@eventBus/ProgressEventBus';
// Type imports
import type { StreamStatusOrReady } from '@eventBus/ProgressEventBus';

const statusMemory = new Map<StreamTabId, StreamStatusOrReady>();

export const StreamStatusService = {
  get(stream: StreamTabId): StreamStatusOrReady {
    return statusMemory.get(stream) ?? STREAM_STATUS.READY;
  },

  set(stream: StreamTabId, status: StreamStatusOrReady): void {
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
