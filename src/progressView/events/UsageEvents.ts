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
  rootCache?: Map<string, string | null>;
}

const createEmptyTotals = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
});

const applyUsage = (
  target: { inputTokens: number; outputTokens: number; cost: number },
  usage: TaskGroup['usage'],
) => {
  if (!usage) {
    return;
  }

  target.inputTokens += usage.inputTokens ?? 0;
  target.outputTokens += usage.outputTokens ?? 0;
  target.cost += usage.cost ?? 0;
};

function findRootGroupId(
  groupId: string,
  context: RunUsageComputationContext,
): string | null {
  const { groups } = context;
  if (!context.rootCache) {
    context.rootCache = new Map();
  }

  if (context.rootCache.has(groupId)) {
    return context.rootCache.get(groupId) ?? null;
  }

  let current = groups.get(groupId);
  if (!current) {
    context.rootCache.set(groupId, null);
    return null;
  }

  while (current.parentGroupId) {
    const parent = groups.get(current.parentGroupId);
    if (!parent) {
      break;
    }
    current = parent;
  }

  context.rootCache.set(groupId, current ? current.id : null);
  return current ? current.id : null;
}

/**
 * Compute total usage for a run by preferring direct child task groups when
 * available. Nested descendants are folded into the totals only when the run
 * lacks immediate child usage, mirroring how the progress view surfaces usage
 * at the top level while avoiding double-counting nested data.
 */
function computeRunUsageTotals(
  runId: string,
  context: RunUsageComputationContext,
): { inputTokens: number; outputTokens: number; cost: number } {
  const directTotals = createEmptyTotals();
  const aggregatedTotals = createEmptyTotals();
  const { groups } = context;
  const rootCache = context.rootCache ?? new Map<string, string | null>();
  context.rootCache = rootCache;

  let runUsage: TaskGroup['usage'] | undefined;

  for (const group of groups.values()) {
    const usage = group.usage;
    if (!usage) {
      continue;
    }

    if (group.id === runId) {
      runUsage = usage;
      continue;
    }

    if (group.parentGroupId === runId) {
      applyUsage(directTotals, usage);
      continue;
    }

    if (!group.parentGroupId) {
      continue;
    }

    const rootId = findRootGroupId(group.id, { ...context, rootCache });
    if (rootId === runId) {
      applyUsage(aggregatedTotals, usage);
    }
  }

  const hasDirect =
    directTotals.inputTokens !== 0 ||
    directTotals.outputTokens !== 0 ||
    directTotals.cost !== 0;
  const hasAggregated =
    aggregatedTotals.inputTokens !== 0 ||
    aggregatedTotals.outputTokens !== 0 ||
    aggregatedTotals.cost !== 0;

  if (runUsage) {
    if (hasDirect) {
      applyUsage(directTotals, runUsage);
      return directTotals;
    }

    if (hasAggregated) {
      applyUsage(aggregatedTotals, runUsage);
      return aggregatedTotals;
    }

    return {
      inputTokens: runUsage.inputTokens ?? 0,
      outputTokens: runUsage.outputTokens ?? 0,
      cost: runUsage.cost ?? 0,
    };
  }

  if (hasDirect) {
    return directTotals;
  }

  if (hasAggregated) {
    return aggregatedTotals;
  }

  return createEmptyTotals();
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
  const resolveTargetRunId = (
    stream: string,
    requestedRunId: string | null | undefined,
    state: ProgressViewState,
  ): string | null => state.resolveRunId(stream, requestedRunId ?? null);

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
            const targetRunId = resolveTargetRunId(stream, runId, state);
            if (!targetRunId) {
              shared.logger.warn(
                `Skipping updateStreamUsage for ${stream}: unable to resolve run ID`,
              );
              return;
            }

            if (!state.getActiveRunId(stream)) {
              state.setActiveRunId(stream, targetRunId);
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
