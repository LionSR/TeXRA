// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import {
  registerSimpleEvents,
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
export function createRetryEventsModule(
  shared: RetryEventsShared,
): RetryEventsModule {
  const { withErrorBoundary } = shared;

  return {
    register(bus) {
      return registerSimpleEvents(bus, withErrorBoundary, [
        {
          event: 'showRetryRequest',
          errorMessage: 'failed to show retry request',
          handler: shared.showRetryRequest,
        },
        {
          event: 'resolveRetryRequest',
          errorMessage: 'failed to resolve retry request',
          handler: (payload) => shared.resolveRetryRequest(payload.streamId),
        },
      ]);
    },
  };
}
