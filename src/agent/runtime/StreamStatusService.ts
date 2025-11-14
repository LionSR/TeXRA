// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Internal imports
import { STATUS } from '@progressView/modules/constants.js';

// Internal imports
import { bus } from '@eventBus/ProgressEventBus';
import type { StreamStatusOrReady } from '@eventBus/ProgressEventBus';

const statusMemory = new Map<StreamTabId, StreamStatusOrReady>();

export const StreamStatusService = {
  get(stream: StreamTabId): StreamStatusOrReady {
    return statusMemory.get(stream) ?? STATUS.READY;
  },

  set(stream: StreamTabId, status: StreamStatusOrReady): void {
    if (status === STATUS.READY) {
      statusMemory.delete(stream);
    } else {
      statusMemory.set(stream, status);
    }

    bus.emit('updateStreamStatus', { stream, status });
  },

  clear(stream: StreamTabId): void {
    this.set(stream, STATUS.READY);
  },
};
