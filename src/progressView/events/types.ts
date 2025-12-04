// Local imports - event bus
import type {
  ProgressEvent,
  ProgressEventPayloads,
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
