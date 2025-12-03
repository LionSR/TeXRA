// Local imports - event bus
import type {
  ProgressEvent,
  ProgressEventPayloads,
  StreamStatus,
  StreamStatusOrReady,
} from '@eventBus/ProgressEventBus';

// Re-export for backward compatibility with existing consumers
export type StreamStatusType = StreamStatus;
export type StreamStatusOrReadyType = StreamStatusOrReady;
export type StatusType = StreamStatusOrReady;

export interface ProgressEventBusLike {
  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
  ): () => void;
  emit<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}
