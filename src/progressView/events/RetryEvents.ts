// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { AgentLogger } from '@logger/AgentLogger';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import { createErrorBoundary } from './errorHandling';
import type { ProgressEventBusLike } from './types';

export interface RetryEventsShared {
  logger: AgentLogger;
}

export interface RetryEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
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

  const handleShowRetryRequest = (
    payload: ProgressEventPayloads['showRetryRequest'],
    updater: WebviewUpdater,
  ): void => {
    updater.showRetryRequest(payload);
  };

  const handleResolveRetryRequest = (
    payload: ProgressEventPayloads['resolveRetryRequest'],
    updater: WebviewUpdater,
  ): void => {
    updater.resolveRetryRequest(payload.streamId);
  };

  return {
    register(
      bus: ProgressEventBusLike,
      _state: ProgressViewState,
      updater: WebviewUpdater,
    ): vscode.Disposable[] {
      return [
        new vscode.Disposable(
          bus.on('showRetryRequest', (payload) =>
            withErrorBoundary('failed to show retry request', () =>
              handleShowRetryRequest(payload, updater),
            ),
          ),
        ),
        new vscode.Disposable(
          bus.on('resolveRetryRequest', (payload) =>
            withErrorBoundary('failed to resolve retry request', () =>
              handleResolveRetryRequest(payload, updater),
            ),
          ),
        ),
      ];
    },
  };
}
