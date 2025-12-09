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
            // Normalize required fields and preserve optional extended metrics
            const normalizedUsage: PersistedUsageStats = {
              inputTokens: Number(usage.inputTokens ?? 0),
              outputTokens: Number(usage.outputTokens ?? 0),
              cost: Number(usage.cost ?? 0),
              // Preserve extended metrics when available
              ...(usage.responseTimeMs !== undefined && {
                responseTimeMs: Number(usage.responseTimeMs),
              }),
              ...(usage.cachedInputTokens !== undefined && {
                cachedInputTokens: Number(usage.cachedInputTokens),
              }),
              ...(usage.cacheCreationTokens !== undefined && {
                cacheCreationTokens: Number(usage.cacheCreationTokens),
              }),
              ...(usage.percentageCached !== undefined && {
                percentageCached: Number(usage.percentageCached),
              }),
              ...(usage.reasoningTokens !== undefined && {
                reasoningTokens: Number(usage.reasoningTokens),
              }),
              ...(usage.toolUsePromptTokens !== undefined && {
                toolUsePromptTokens: Number(usage.toolUsePromptTokens),
              }),
              ...(usage.serverToolRequests !== undefined && {
                serverToolRequests: Number(usage.serverToolRequests),
              }),
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
