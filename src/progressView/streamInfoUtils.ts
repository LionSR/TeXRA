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
 * Build a single StreamTabInfo for the given stream ID.
 * Returns null if the stream should be filtered out.
 */
function buildStreamInfo(
  state: ProgressViewState,
  id: string,
  statuses: Map<string, string> | undefined,
  filter: AgentFilter,
): StreamTabInfo | null {
  const taskState = state.getTaskState(id);
  const hints = state.getStreamHints(id);
  const logs = state.streamTabs.getMessages(id);
  const rawCategory =
    taskState?.agentConfig.session?.agentCategory ?? hints.sessionCategory;

  // Filter check: returns resolved category or null if filtered out
  const sessionCategory = matchesFilter(rawCategory, filter);
  if (sessionCategory === null) {
    return null;
  }

  const rawAgentName = taskState?.agentConfig.agent ?? id.split('@')[0];
  const agentName = getCleanAgentName(rawAgentName);
  const inputFile = taskState?.agentConfig.inputFile ?? '';
  const isToolAgent = sessionCategory === AgentCategory.ToolUse;

  // Build label: tool-use shows agent only, workflows show agent + file basename
  const label =
    isToolAgent || !inputFile
      ? agentName
      : `${agentName}: ${path.basename(inputFile)}`;

  return {
    name: id,
    label,
    model: taskState?.agentConfig.model,
    agent: taskState?.agentConfig.agent,
    agentType:
      taskState?.agentConfig.session?.agentType ??
      taskState?.agentConfig.agentType,
    agentSessionKind: sessionCategory,
    uiTraits: { sessionKind: sessionCategory, isToolAgent },
    hasMultipleOutputs: taskState
      ? taskState.agentConfig.useMultipleOutputs
      : (hints.hasMultipleOutputs ?? false),
    isRemote: taskState
      ? isRemoteAgent(rawAgentName)
      : (hints.isRemote ?? false),
    lastTimestamp: logs.at(-1)?.timestamp,
    inputFile,
    creationTimestamp: logs[0]?.timestamp,
    status: statuses?.get(id),
    executionId: state.getExecutionId(id),
  };
}

/**
 * Build metadata objects for all streams in the given state.
 */
export function buildStreamInfos(
  state: ProgressViewState,
  statuses?: Map<string, string>,
  filter: AgentFilter = 'all',
): StreamTabInfo[] {
  const infos = state.streamTabs
    .keys()
    .map((id) => buildStreamInfo(state, id, statuses, filter))
    .filter((info): info is StreamTabInfo => info !== null);

  const comparator = sortComparators[state.streamSortOrder];
  if (comparator) {
    infos.sort(comparator);
  }

  return infos;
}
