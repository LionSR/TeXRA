import {
  isActiveStatus,
  isInFlightStatus,
} from '@common/constants/streamStatus';
import { bus } from '@eventBus/ProgressEventBus';
import {
  STREAM_STATUS,
  type StreamTabId,
  type StreamStatus,
} from '@shared/schemas';

const statusMemory = new Map<StreamTabId, StreamStatus>();

interface SetOptions {
  emit?: boolean;
}

export const StreamStatusService = {
  get(stream: StreamTabId): StreamStatus | undefined {
    return statusMemory.get(stream);
  },

  tryAcquire(stream: StreamTabId): boolean {
    if (isInFlightStatus(statusMemory.get(stream))) {
      return false;
    }
    this.set(stream, STREAM_STATUS.INITIALIZING);
    return true;
  },

  releaseIfInitializing(stream: StreamTabId): void {
    if (statusMemory.get(stream) === STREAM_STATUS.INITIALIZING) {
      this.clear(stream);
    }
  },

  set(
    stream: StreamTabId,
    status: StreamStatus,
    options: SetOptions = {},
  ): void {
    const { emit = true } = options;

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

  clear(stream: StreamTabId): void {
    this.set(stream, STREAM_STATUS.READY);
  },

  entries(): IterableIterator<[StreamTabId, StreamStatus]> {
    return statusMemory.entries();
  },

  getAll(): Map<StreamTabId, StreamStatus> {
    return new Map(statusMemory);
  },

  has(stream: StreamTabId): boolean {
    return statusMemory.has(stream);
  },

  isActiveOrResuming(stream: StreamTabId): boolean {
    return isActiveStatus(statusMemory.get(stream));
  },

  shouldPreserveOnCompletion(stream: StreamTabId): boolean {
    const status = statusMemory.get(stream);
    return status === STREAM_STATUS.WAITING || status === STREAM_STATUS.STOPPED;
  },
};
