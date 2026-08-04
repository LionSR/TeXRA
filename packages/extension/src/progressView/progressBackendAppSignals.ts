import type { ProgressBackend } from '@controllers/progressView/backend/ProgressBackend';
import type { AppSignalsLike } from '@eventBus/AppSignals';

/**
 * Attach extension app-lifecycle signals to the shared progress backend.
 * This adapter keeps app-scoped shutdown facts out of the progress event bus.
 */
export function attachProgressBackendAppSignals(
  backend: Pick<ProgressBackend, 'markAllRunningTasksAsCancelled'>,
  signals: AppSignalsLike,
): { dispose(): void } {
  const dispose = signals.on('extensionDeactivating', () => {
    backend.markAllRunningTasksAsCancelled();
  });

  return { dispose };
}
