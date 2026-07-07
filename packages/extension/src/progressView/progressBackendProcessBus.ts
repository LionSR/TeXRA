import type {
  ProgressEvent,
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import type { ProgressBackend } from '@shared/progressView/backend/ProgressBackend';
import type { ProgressEventSubscription } from '@shared/progressView/backend/events/ProgressEventHandler';

/**
 * Attach the VS Code extension's legacy process bus to the shared progress
 * backend. This is an extension boundary adapter: the backend itself remains
 * local/session-scoped.
 */
export function attachProgressBackendProcessBus(
  backend: Pick<ProgressBackend, 'eventHandler'>,
  bus: ProgressEventBusLike,
): ProgressEventSubscription {
  const backendBus: ProgressEventBusLike = {
    on<K extends ProgressEvent>(
      event: K,
      listener: (payload: ProgressEventPayloads[K]) => void,
      options?: { signal?: AbortSignal },
    ): () => void {
      if (event === 'addOutputFiles') return () => {};
      return bus.on(event, listener, options);
    },
    emit<K extends ProgressEvent>(
      event: K,
      payload: ProgressEventPayloads[K],
    ): void {
      bus.emit(event, payload);
    },
  };

  return backend.eventHandler.setupEventListeners(backendBus);
}
