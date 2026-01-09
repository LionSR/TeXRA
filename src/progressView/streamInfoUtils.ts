// Standard library imports
import * as path from 'path';

// Local imports - progress view
import { getCleanAgentName, isRemoteAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';

// Type imports
import type { ProgressViewState } from './state/ProgressViewState';
import type { AgentFilter, StreamTabInfo } from './types';

const sortComparators: Record<
  string,
  (a: StreamTabInfo, b: StreamTabInfo) => number
> = {
  time: (a, b) =>
    (b.lastTimestamp ?? b.creationTimestamp ?? 0) -
    (a.lastTimestamp ?? a.creationTimestamp ?? 0),
  inputFile: (a, b) => (a.inputFile ?? '').localeCompare(b.inputFile ?? ''),
  agent: (a, b) => (a.agent ?? '').localeCompare(b.agent ?? ''),
};

/**
 * Check if a session category matches the given filter.
 * Returns the category to use (defaulting to Workflow) or null if filtered out.
 */
function matchesFilter(
  category: AgentCategory | undefined,
  filter: AgentFilter,
): AgentCategory | null {
  // When filter is 'all', accept everything (default to Workflow if no category)
  if (filter === 'all') {
    return category ?? AgentCategory.Workflow;
  }

  // No category means we can't match a specific filter
  if (!category) {
    return null;
  }

  // Map filter values to expected categories
  const expectedCategory =
    filter === 'toolUse' ? AgentCategory.ToolUse : AgentCategory.Workflow;

  return category === expectedCategory ? category : null;
}

/**
 * Build metadata objects for all streams in the given state.
 */
export function buildStreamInfos(
  state: ProgressViewState,
  statuses?: Map<string, string>,
  filter: AgentFilter = 'all',
): StreamTabInfo[] {
  const infos = state.streamTabs.keys().reduce<StreamTabInfo[]>((acc, id) => {
    const taskState = state.getTaskState(id);
    const hints = state.getStreamHints(id);
    const logs = state.streamTabs.getMessages(id);
    const lastTimestamp = logs.length > 0 ? logs.at(-1)?.timestamp : undefined;
    const creationTimestamp = logs.length > 0 ? logs[0].timestamp : undefined;
    const inputFile = taskState?.agentConfig.inputFile ?? '';
    // Extract clean agent name (strip source: prefix if present)
    const rawAgentName = taskState?.agentConfig.agent ?? id.split('@')[0];
    const agentName = getCleanAgentName(rawAgentName);
    const rawCategory =
      taskState?.agentConfig.session?.agentCategory ?? hints.sessionCategory;

    // Filter check: returns resolved category or null if filtered out
    const sessionCategory = matchesFilter(rawCategory, filter);
    if (sessionCategory === null) {
      return acc;
    }

    const agentType =
      taskState?.agentConfig.session?.agentType ??
      taskState?.agentConfig.agentType;
    const isToolAgent = sessionCategory === AgentCategory.ToolUse;
    // When taskState is available, rawAgentName has the full key (e.g., "remote:generic")
    // and isRemoteAgent can reliably determine the source. When taskState is null,
    // rawAgentName is just the clean name from the stream ID, so fall back to the hint.
    const isRemote = taskState
      ? isRemoteAgent(rawAgentName)
      : (hints.isRemote ?? false);
    const executionId = state.getExecutionId(id);

    // Build label: tool-use shows agent only, workflows show agent + file basename
    let label = agentName;
    if (sessionCategory !== AgentCategory.ToolUse && inputFile) {
      label = `${agentName}: ${path.basename(inputFile)}`;
    }

    acc.push({
      name: id,
      label,
      model: taskState?.agentConfig.model,
      agent: taskState?.agentConfig.agent,
      agentType,
      agentSessionKind: sessionCategory,
      uiTraits: {
        sessionKind: sessionCategory,
        isToolAgent,
      },
      // useMultipleOutputs is the single source of truth (workflow-only concept).
      // When taskState is null, fall back to the hint from setActiveStream event.
      hasMultipleOutputs: taskState
        ? taskState.agentConfig.useMultipleOutputs
        : (hints.hasMultipleOutputs ?? false),
      isRemote,
      lastTimestamp,
      inputFile,
      creationTimestamp,
      status: statuses?.get(id),
      executionId,
    });
    return acc;
  }, []);

  const comparator = sortComparators[state.streamSortOrder];
  if (comparator) {
    infos.sort(comparator);
  }

  return infos;
}
