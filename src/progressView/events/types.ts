// Local imports - event bus
import type {
  ProgressEvent,
  ProgressEventPayloads,
  StreamStatus as ProgressStreamStatus,
  StreamStatusOrReady as ProgressStreamStatusOrReady,
} from '@eventBus/ProgressEventBus';

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

export type ErrorBoundary = (context: string, fn: () => void) => void;

export type StreamStatusType = ProgressStreamStatus;
export type StreamStatusOrReadyType = ProgressStreamStatusOrReady;
export type StatusType = ProgressStreamStatusOrReady;
