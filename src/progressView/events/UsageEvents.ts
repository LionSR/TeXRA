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
 * Cleanup is automatic via AbortSignal.
 */
export function registerUsageEvents(
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
  signal: AbortSignal,
): void {
  bus.on(
    'updateStreamUsage',
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

          await state.usageStats.setRunUsage(stream, storageKey, normalizedUsage);

          sendIfActive(stream, state, updater, () => {
            updater.updateRunUsage(stream, storageKey, normalizedUsage);
          });
        },
      );
    },
    { signal },
  );
}
