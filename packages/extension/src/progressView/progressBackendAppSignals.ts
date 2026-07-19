import type { ProgressBackend } from '@controllers/progressView/backend/ProgressBackend';
import type { ProgressEventSubscription } from '@controllers/progressView/backend/events/ProgressFactApplier';
import type { AppSignalsLike } from '@eventBus/AppSignals';

/**
 * Attach extension app-lifecycle signals to the shared progress backend.
 * This adapter keeps app-scoped shutdown facts out of the progress event bus.
 */
export function attachProgressBackendAppSignals(
  backend: Pick<ProgressBackend, 'factApplier'>,
  signals: AppSignalsLike,
): ProgressEventSubscription {
  const dispose = signals.on('extensionDeactivating', () => {
    backend.factApplier.markAllRunningTasksAsCancelled();
  });

  return { dispose };
}
