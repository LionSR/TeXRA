// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

// Local imports - events
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { createErrorBoundary } from './errorHandling';
import type { ProgressEventBusLike } from './types';

import type { AgentLogger } from '@logger/AgentLogger';

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
        ({ stream, groupId, usage }) => {
          withErrorBoundary('failed to handle updateStreamUsage', () => {
            const targetGroupId =
              groupId ??
              state.getSelectedTaskGroupId(stream) ??
              state.getLatestTaskGroupId(stream);

            if (!targetGroupId) {
              return;
            }

            state.usageStats.updateSessionUsage(stream, targetGroupId, usage);

            if (state.activeStream === stream && updater.isAvailable()) {
              const selectedGroupId =
                state.getSelectedTaskGroupId(stream) ?? targetGroupId;
              if (selectedGroupId === targetGroupId) {
                const latestUsage =
                  state.usageStats.getSessionUsage(stream, targetGroupId) ||
                  usage;
                updater.updateUsage(latestUsage);
              }
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
