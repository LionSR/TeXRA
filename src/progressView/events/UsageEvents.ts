// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';

// Local file imports
import { createErrorBoundary } from './errorHandling';

// Type imports
import type { ProgressEventBusLike } from './types';

export interface UsageEventsModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}

interface UsageEventsShared {
  logger: AgentLogger;
}

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
              const usageByRun = Object.fromEntries(
                state.usageStats.getRunUsage(stream).entries(),
              ) as Record<string, TokenUsageStats>;
              updater.updateUsage(stream, usageByRun);
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
