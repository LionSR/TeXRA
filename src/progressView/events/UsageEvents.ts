// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

// Local imports - events
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import type { AgentLogger } from '@logger/AgentLogger';
import type { ErrorBoundary, ProgressEventBusLike } from './types';
import { createErrorBoundary } from './errorHandling';

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
  const withErrorBoundary: ErrorBoundary = createErrorBoundary(
    shared.logger,
    'UsageEvents',
  );

  return {
    register(
      bus: ProgressEventBusLike,
      state: ProgressViewState,
      updater: WebviewUpdater,
    ): vscode.Disposable[] {
      const updateGroupUsage = bus.on(
        'updateGroupUsage',
        ({ stream, groupId, usage }) => {
          withErrorBoundary('failed to handle updateGroupUsage', () => {
            const group = state.taskGroups.getGroup(stream, groupId);
            if (group) {
              state.taskGroups.updateGroup(stream, groupId, { usage });
            }
          });
        },
      );

      const updateStreamUsage = bus.on(
        'updateStreamUsage',
        ({ stream, usage }) => {
          withErrorBoundary('failed to handle updateStreamUsage', () => {
            state.usageStats.updateStreamUsage(stream, usage);
            if (state.activeStream === stream && updater.isAvailable()) {
              updater.updateUsage(usage);
            }
          });
        },
      );

      return [updateGroupUsage, updateStreamUsage].map(
        (dispose) => new vscode.Disposable(dispose),
      );
    },
  };
}
