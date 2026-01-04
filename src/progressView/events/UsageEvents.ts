// Type imports
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import {
  createStatefulEventDisposable,
  sendIfActive,
  type ProgressEventBusLike,
  type StatefulEventModule,
} from './types';
import { withEventErrorHandling } from './errorHandling';

const MODULE = 'UsageEvents';

export type UsageEventsModule = StatefulEventModule;

/**
 * Create usage event module for registration.
 */
export function createUsageEvents(_shared: unknown = {}): UsageEventsModule {
  return {
    register(bus, state, updater) {
      return [
        createStatefulEventDisposable(
          bus,
          'updateStreamUsage',
          state,
          updater,
          ({ stream, usage, storageKey }) => {
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
          },
        ),
      ];
    },
  };
}
