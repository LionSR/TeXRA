// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import type { ProgressEventBusLike, Unsubscribe } from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'RetryEvents';

/**
 * Callbacks for retry event handling.
 */
export interface RetryCallbacks {
  showRetryRequest: (
    payload: ProgressEventPayloads['showRetryRequest'],
  ) => void;
  resolveRetryRequest: (streamId: string) => void;
}

/**
 * Register retry event handlers.
 * Returns unsubscribe functions - caller handles VSCode Disposable wrapping.
 */
export function registerRetryEvents(
  bus: ProgressEventBusLike,
  callbacks: RetryCallbacks,
): Unsubscribe[] {
  return [
    bus.on('showRetryRequest', (payload) =>
      withEventErrorHandling(MODULE, 'failed to show retry request', () =>
        callbacks.showRetryRequest(payload),
      ),
    ),
    bus.on('resolveRetryRequest', (payload) =>
      withEventErrorHandling(MODULE, 'failed to resolve retry request', () =>
        callbacks.resolveRetryRequest(payload.streamId),
      ),
    ),
  ];
}
