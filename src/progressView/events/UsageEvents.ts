// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { PersistedUsageStats } from '@agent/types/UsageTypes';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
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
 * Uses BaseEventShared which provides withErrorBoundary.
 */
type UsageEventsShared = BaseEventShared;

export function createUsageEvents(
  shared: UsageEventsShared,
): UsageEventsModule {
  const { withErrorBoundary } = shared;

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
            // Usage is already PersistedUsageStats from AgentUsageReporter;
            // UsageStatsManager.setRunUsage() handles parsing/normalization
            await state.usageStats.setRunUsage(stream, storageKey, usage);

            if (state.activeStream === stream && updater.isAvailable()) {
              updater.updateRunUsage(stream, storageKey, usage);
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
