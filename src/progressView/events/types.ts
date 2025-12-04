// Local imports - event bus
import type {
  ProgressEvent,
  ProgressEventPayloads,
  StreamStatus,
  StreamStatusOrReady,
} from '@eventBus/ProgressEventBus';

/**
 * @deprecated Use `StreamStatus` from '@eventBus/ProgressEventBus' directly.
 * This alias exists only for backward compatibility.
 */
export type StreamStatusType = StreamStatus;

/**
 * @deprecated Use `StreamStatusOrReady` from '@eventBus/ProgressEventBus' directly.
 * This alias exists only for backward compatibility.
 */
export type StreamStatusOrReadyType = StreamStatusOrReady;

/**
 * @deprecated Use `StreamStatusOrReady` from '@eventBus/ProgressEventBus' directly.
 * This alias exists only for backward compatibility.
 */
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
