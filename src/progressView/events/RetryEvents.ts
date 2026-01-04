// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import {
  createEventDisposable,
  type EventModuleBase,
  type ProgressEventBusLike,
} from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'RetryEvents';

/**
 * Callbacks for retry event handling.
 */
export interface RetryEventsShared {
  showRetryRequest: (
    payload: ProgressEventPayloads['showRetryRequest'],
  ) => void;
  resolveRetryRequest: (streamId: string) => void;
}

export type RetryEventsModule = EventModuleBase;

/**
 * Create retry event module for registration.
 */
export function createRetryEvents(
  callbacks: RetryEventsShared,
): RetryEventsModule {
  return {
    register(bus) {
      return [
        createEventDisposable(bus, 'showRetryRequest', (payload) =>
          withEventErrorHandling(MODULE, 'failed to show retry request', () =>
            callbacks.showRetryRequest(payload),
          ),
        ),
        createEventDisposable(bus, 'resolveRetryRequest', (payload) =>
          withEventErrorHandling(
            MODULE,
            'failed to resolve retry request',
            () => callbacks.resolveRetryRequest(payload.streamId),
          ),
        ),
      ];
    },
  };
}
