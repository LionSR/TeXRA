// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import type { ProgressEventBusLike } from './types';
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
 */
export function registerRetryEvents(
  bus: ProgressEventBusLike,
  callbacks: RetryCallbacks,
): vscode.Disposable[] {
  return [
    new vscode.Disposable(
      bus.on('showRetryRequest', (payload) =>
        withEventErrorHandling(MODULE, 'failed to show retry request', () =>
          callbacks.showRetryRequest(payload),
        ),
      ),
    ),
    new vscode.Disposable(
      bus.on('resolveRetryRequest', (payload) =>
        withEventErrorHandling(MODULE, 'failed to resolve retry request', () =>
          callbacks.resolveRetryRequest(payload.streamId),
        ),
      ),
    ),
  ];
}
