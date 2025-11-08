// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { TaskGroupUpdatePayload, WebviewUpdater } from '../managers';
import type { ProgressViewState } from '../state/ProgressViewState';

// Local imports - events
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import { createErrorBoundary } from './errorHandling';
import type { ProgressEventBusLike } from './types';

import type { AgentLogger } from '@logger/AgentLogger';
import type { TaskGroup } from '@logger/LogTypes';
import type { TokenUsageStats } from '@agent/types/UsageTypes';

interface RunUsageComputationContext {
  groups: Map<string, TaskGroup>;
}

function findRootGroupId(
  groupId: string,
  { groups }: RunUsageComputationContext,
): string | null {
  let current = groups.get(groupId);
  if (!current) {
    return null;
  }

  while (current.parentGroupId) {
    const parent = groups.get(current.parentGroupId);
    if (!parent) {
      break;
    }
    current = parent;
  }

  return current ? current.id : null;
}

function computeRunUsageTotals(
  runId: string,
  context: RunUsageComputationContext,
): { inputTokens: number; outputTokens: number; cost: number } {
  const totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
  const { groups } = context;

  let hasDirectChildUsage = false;

  for (const group of groups.values()) {
    if (group.parentGroupId !== runId) {
      continue;
    }

    if (!group.usage) {
      continue;
    }

    totals.inputTokens += group.usage.inputTokens ?? 0;
    totals.outputTokens += group.usage.outputTokens ?? 0;
    totals.cost += group.usage.cost ?? 0;
    hasDirectChildUsage = true;
  }

  if (hasDirectChildUsage) {
    return totals;
  }

  for (const group of groups.values()) {
    if (group.id === runId) {
      continue;
    }

    if (findRootGroupId(group.id, context) !== runId) {
      continue;
    }

    if (!group.usage) {
      continue;
    }

    totals.inputTokens += group.usage.inputTokens ?? 0;
    totals.outputTokens += group.usage.outputTokens ?? 0;
    totals.cost += group.usage.cost ?? 0;
  }

  if (
    totals.inputTokens === 0 &&
    totals.outputTokens === 0 &&
    totals.cost === 0
  ) {
    const runGroup = groups.get(runId);
    if (runGroup?.usage) {
      totals.inputTokens = runGroup.usage.inputTokens ?? 0;
      totals.outputTokens = runGroup.usage.outputTokens ?? 0;
      totals.cost = runGroup.usage.cost ?? 0;
    }
  }

  return totals;
}

async function refreshRunUsage(
  stream: string,
  runId: string,
  state: ProgressViewState,
  updater: WebviewUpdater,
): Promise<void> {
  if (!runId) {
    return;
  }

  const groups = state.taskGroups.getStreamGroups(stream);
  const totals = computeRunUsageTotals(runId, { groups });
  await state.usageStats.setRunUsage(stream, runId, totals);

  if (state.activeStream === stream && updater.isAvailable()) {
    const usageByRun = Object.fromEntries(
      state.usageStats.getRunUsage(stream).entries(),
    ) as Record<string, TokenUsageStats>;
    updater.updateUsage(stream, usageByRun);
  }
}

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
          withErrorBoundary('failed to handle updateGroupUsage', async () => {
            const group = state.taskGroups.getGroup(stream, groupId);
            if (group) {
              const update: TaskGroupUpdatePayload = {
                stream,
                groupId,
                updates: { usage },
              };
              await state.taskGroups.updateGroup(update);
              const rootId = findRootGroupId(group.id, {
                groups: state.taskGroups.getStreamGroups(stream),
              });
              if (rootId) {
                await refreshRunUsage(stream, rootId, state, updater);
              }
            }
          });
        },
      );

      const updateStreamUsage = bus.on(
        'updateStreamUsage',
        ({ stream, usage, runId }) => {
          withErrorBoundary('failed to handle updateStreamUsage', async () => {
            const targetRunId =
              runId ?? state.getActiveRunId(stream) ?? undefined;
            if (!targetRunId) {
              return;
            }
            await state.usageStats.setRunUsage(stream, targetRunId, usage);
            if (state.activeStream === stream && updater.isAvailable()) {
              const usageByRun = Object.fromEntries(
                state.usageStats.getRunUsage(stream).entries(),
              ) as Record<string, TokenUsageStats>;
              updater.updateUsage(stream, usageByRun);
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
