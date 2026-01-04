// Type imports
import type { TokenUsageStats } from '@agent/types/UsageTypes';

// Local file imports
import {
  createStatefulEventDisposable,
  sendIfActive,
  type BaseEventShared,
  type StatefulEventModule,
} from './types';

export type UsageEventsModule = StatefulEventModule;

export function createUsageEvents(shared: BaseEventShared): UsageEventsModule {
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

                await state.usageStats.setRunUsage(stream, storageKey, normalizedUsage);

                sendIfActive(stream, state, updater, () => {
                  updater.updateRunUsage(stream, storageKey, normalizedUsage);
                });
              },
            );
          },
        ),
      ];
    },
  };
}
