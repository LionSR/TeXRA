// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import {
  createEventDisposable,
  type BaseEventShared,
  type EventModuleBase,
  type ProgressEventBusLike,
} from './types';

/**
 * Shared context for RetryEvents module.
 * Extends BaseEventShared with retry-specific callbacks.
 */
export interface RetryEventsShared extends BaseEventShared {
  /** Callback to show retry request (routes through provider for queueing) */
  showRetryRequest: (
    payload: ProgressEventPayloads['showRetryRequest'],
  ) => void;
  /** Callback to resolve retry request (routes through provider for queueing) */
  resolveRetryRequest: (streamId: string) => void;
}

/**
 * RetryEvents module interface.
 * Uses EventModuleBase pattern (bus only, no state/updater).
 */
export type RetryEventsModule = EventModuleBase;

/**
 * Creates a module for handling retry request events.
 * Follows the established event module pattern used by StreamStatusEvents, LogEvents, etc.
 */
export function createRetryEvents(
  shared: RetryEventsShared,
): RetryEventsModule {
  const { withErrorBoundary } = shared;

  return {
    register(bus: ProgressEventBusLike) {
      return [
        createEventDisposable(bus, 'showRetryRequest', (payload) =>
          withErrorBoundary('failed to show retry request', () =>
            shared.showRetryRequest(payload),
          ),
        ),
        createEventDisposable(bus, 'resolveRetryRequest', (payload) =>
          withErrorBoundary('failed to resolve retry request', () =>
            shared.resolveRetryRequest(payload.streamId),
          ),
        ),
      ];
    },
  };
}
