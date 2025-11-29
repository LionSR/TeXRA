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

  const resolveTargetRunId = (
    stream: string,
    requestedRunId: string | null | undefined,
    state: ProgressViewState,
  ): string | null => {
    if (requestedRunId) {
      return requestedRunId;
    }
    return state.resolveRunId(stream, null);
  };

  return {
    register(
      bus: ProgressEventBusLike,
      state: ProgressViewState,
      updater: WebviewUpdater,
    ): vscode.Disposable[] {
      const updateStreamUsage = bus.on(
        'updateStreamUsage',
        ({ stream, usage, runId }) => {
          withErrorBoundary('failed to handle updateStreamUsage', async () => {
            const normalizedUsage: TokenUsageStats = {
              inputTokens: Number(usage.inputTokens ?? 0),
              outputTokens: Number(usage.outputTokens ?? 0),
              cost: Number(usage.cost ?? 0),
            };

            const resolvedRunId = resolveTargetRunId(stream, runId, state);
            const targetRunId = resolvedRunId ?? runId ?? null;

            if (!targetRunId) {
              shared.logger.warn(
                `Skipping updateStreamUsage for ${stream}: unable to resolve run ID`,
              );
              return;
            }

            if (!state.getActiveRunId(stream)) {
              state.setActiveRunId(stream, targetRunId);
            }

            await state.usageStats.setRunUsage(
              stream,
              targetRunId,
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
