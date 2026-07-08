import type { AppSignalsLike } from '@eventBus/AppSignals';
import type { ProgressBackend } from '@shared/progressView/backend/ProgressBackend';
import type { ProgressEventSubscription } from '@shared/progressView/backend/events/ProgressFactApplier';

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
