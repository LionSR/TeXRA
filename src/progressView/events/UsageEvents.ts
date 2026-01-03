// Type imports
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import {
  createStatefulEventDisposable,
  type ProgressEventBusLike,
} from './types';
import type { BaseEventShared, StatefulEventModule } from './types';

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
    register(bus, state, updater) {
      return [
        createStatefulEventDisposable(
          bus,
          'updateStreamUsage',
          state,
          updater,
          ({ stream, usage, storageKey }) => {
            withErrorBoundary(
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

                if (state.activeStream === stream && updater.isAvailable()) {
                  updater.updateRunUsage(stream, storageKey, normalizedUsage);
                }
              },
            );
          },
        ),
      ];
    },
  };
}
