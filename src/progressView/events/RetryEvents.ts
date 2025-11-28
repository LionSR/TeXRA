// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { AgentLogger } from '@logger/AgentLogger';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import { createErrorBoundary } from './errorHandling';
import type { ProgressEventBusLike } from './types';

export interface RetryEventsShared {
  logger: AgentLogger;
  /** Callback to show retry request (routes through provider for queueing) */
  showRetryRequest: (
    payload: ProgressEventPayloads['showRetryRequest'],
  ) => void;
  /** Callback to resolve retry request (routes through provider for queueing) */
  resolveRetryRequest: (streamId: string) => void;
}

export interface RetryEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
  ): vscode.Disposable[];
}

/**
 * Creates a module for handling retry request events.
 * Follows the established event module pattern used by StreamStatusEvents, LogEvents, etc.
 */
export function createRetryEventsModule(
  shared: RetryEventsShared,
): RetryEventsModule {
  const withErrorBoundary = createErrorBoundary(shared.logger, 'RetryEvents');

  return {
    register(
      bus: ProgressEventBusLike,
      _state: ProgressViewState,
    ): vscode.Disposable[] {
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
