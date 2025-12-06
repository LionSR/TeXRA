// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import { createErrorBoundary } from './errorHandling';
import type {
  BaseEventShared,
  ProgressEventBusLike,
  StatefulEventModule,
} from './types';

/**
 * UsageEvents module interface.
 * Uses StatefulEventModule pattern for state/updater access.
 */
export type UsageEventsModule = StatefulEventModule;

/**
 * Shared context for UsageEvents module.
 * Uses BaseEventShared which provides logger for error boundary.
 */
type UsageEventsShared = BaseEventShared;

export function createUsageEvents(
  shared: UsageEventsShared,
): UsageEventsModule {
  const withErrorBoundary = createErrorBoundary(shared.logger, 'UsageEvents');

  return {
    register(
      bus: ProgressEventBusLike,
      state: ProgressViewState,
      updater: WebviewUpdater,
    ): vscode.Disposable[] {
      const updateStreamUsage = bus.on(
        'updateStreamUsage',
        ({ stream, usage, storageKey }) => {
          withErrorBoundary('failed to handle updateStreamUsage', async () => {
            const normalizedUsage: TokenUsageStats = {
              inputTokens: Number(usage.inputTokens ?? 0),
              outputTokens: Number(usage.outputTokens ?? 0),
              cost: Number(usage.cost ?? 0),
            };

            // storageKey is THE single source of truth - no fallbacks
            await state.usageStats.setRunUsage(
              stream,
              storageKey,
              normalizedUsage,
            );

            if (state.activeStream === stream && updater.isAvailable()) {
              // Send only the changed run's usage instead of all runs
              updater.updateRunUsage(stream, storageKey, normalizedUsage);
            }
          });
        },
      );

      return [updateStreamUsage].map(
        (dispose) => new vscode.Disposable(dispose),
      );
    },
  };
}
