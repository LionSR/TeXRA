// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import { sendIfActive, type ProgressEventBusLike } from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'UsageEvents';

/**
 * Register usage event handlers.
 */
export function registerUsageEvents(
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
): vscode.Disposable[] {
  return [
    new vscode.Disposable(
      bus.on('updateStreamUsage', ({ stream, usage, storageKey }) => {
        withEventErrorHandling(
          MODULE,
          'failed to handle updateStreamUsage',
          async () => {
            const normalizedUsage: TokenUsageStats = {
              inputTokens: Number(usage.inputTokens ?? 0),
              outputTokens: Number(usage.outputTokens ?? 0),
              cost: Number(usage.cost ?? 0),
            };

            await state.usageStats.setRunUsage(
              stream,
              storageKey,
              normalizedUsage,
            );

            sendIfActive(stream, state, updater, () => {
              updater.updateRunUsage(stream, storageKey, normalizedUsage);
            });
          },
        );
      }),
    ),
  ];
}
