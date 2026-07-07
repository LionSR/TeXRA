import type { ProgressEventBusLike } from '@eventBus/ProgressEventBus';
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
  return backend.eventHandler.setupEventListeners(bus);
}
