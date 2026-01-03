// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import type {
  BaseEventShared,
  EventModuleBase,
  ProgressEventBusLike,
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
    register(bus: ProgressEventBusLike): vscode.Disposable[] {
      return [
        new vscode.Disposable(
          bus.on('showRetryRequest', (payload) =>
            withErrorBoundary('failed to show retry request', () =>
              shared.showRetryRequest(payload),
            ),
          ),
        ),
        new vscode.Disposable(
          bus.on('resolveRetryRequest', (payload) =>
            withErrorBoundary('failed to resolve retry request', () =>
              shared.resolveRetryRequest(payload.streamId),
            ),
          ),
        ),
      ];
    },
  };
}
