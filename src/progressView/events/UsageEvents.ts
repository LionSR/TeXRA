// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import type { TaskGroup } from '@logger/LogTypes';
import type {
  TaskGroupUpdatePayload,
  WebviewUpdater,
} from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local file imports
import { createErrorBoundary } from './errorHandling';

// Type imports
import type { ProgressEventBusLike } from './types';

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
 * available. This mirrors the progress view layout: if the run surfaces
 * per-round usage, that aggregate is displayed; otherwise we fall back to the
 * deepest descendants or the run's own usage. The strategy intentionally avoids
 * combining the run's usage with child totals to prevent double-counting when
 * agents report rollups at multiple levels.
 */
function computeRunUsageTotals(
  runId: string,
  context: RunUsageComputationContext,
): { inputTokens: number; outputTokens: number; cost: number } {
  const directTotals = createEmptyTotals();
  const aggregatedTotals = createEmptyTotals();
  const { groups } = context;
  context.rootCache = context.rootCache ?? new Map<string, string | null>();
  const rootCache = context.rootCache;

  let runUsage: TaskGroup['usage'] | undefined;
  let hasDirectChildren = false;
  let hasAggregatedDescendants = false;

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
      hasDirectChildren = true;
      applyUsage(directTotals, usage);
      continue;
    }

    if (!group.parentGroupId) {
      continue;
    }

    const rootId = findRootGroupId(group.id, { ...context, rootCache });
    if (rootId === runId) {
      hasAggregatedDescendants = true;
      applyUsage(aggregatedTotals, usage);
    }
  }

  if (runUsage) {
    if (hasDirectChildren) {
      return directTotals;
    }

    if (hasAggregatedDescendants) {
      return aggregatedTotals;
    }

    return {
      inputTokens: runUsage.inputTokens ?? 0,
      outputTokens: runUsage.outputTokens ?? 0,
      cost: runUsage.cost ?? 0,
    };
  }

  if (hasDirectChildren) {
    return directTotals;
  }

  if (hasAggregatedDescendants) {
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

      return [updateGroupUsage, updateStreamUsage].map(
        (dispose) => new vscode.Disposable(dispose),
      );
    },
  };
}
