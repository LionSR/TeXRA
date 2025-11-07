import { bus } from '@eventBus/ProgressEventBus';
import type { StreamStatusOrReady } from '@eventBus/ProgressEventBus';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { STATUS } from '@progressView/modules/constants.js';

const statusMemory = new Map<StreamTabId, StreamStatusOrReady>();

function syncProvider(stream: StreamTabId, status: StreamStatusOrReady): void {
  const provider = ProgressViewProvider.getInstance();
  if (!provider) {
    return;
  }
  provider.eventHandler.setStreamStatus(stream, status);
}

export const StreamStatusService = {
  get(stream: StreamTabId): StreamStatusOrReady {
    const provider = ProgressViewProvider.getInstance();
    const providerStatus = provider?.eventHandler.getStreamStatus(stream);
    if (providerStatus) {
      statusMemory.set(stream, providerStatus);
      return providerStatus;
    }
    return statusMemory.get(stream) ?? STATUS.READY;
  },

  set(stream: StreamTabId, status: StreamStatusOrReady): void {
    if (status === STATUS.READY) {
      statusMemory.delete(stream);
    } else {
      statusMemory.set(stream, status);
    }

    bus.emit('updateStreamStatus', { stream, status });
    syncProvider(stream, status);
  },

  clear(stream: StreamTabId): void {
    this.set(stream, STATUS.READY);
  },
};
