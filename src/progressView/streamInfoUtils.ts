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
  if (filter === 'all') {
    return category ?? AgentCategory.Workflow;
  }

  if (!category) {
    return null;
  }

  const expectedCategory =
    filter === 'toolUse' ? AgentCategory.ToolUse : AgentCategory.Workflow;

  return category === expectedCategory ? category : null;
}

/**
 * Build a StreamTabInfo object for a single stream ID.
 * Returns null if the stream doesn't match the filter.
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
  const lastTimestamp = logs.length > 0 ? logs.at(-1)?.timestamp : undefined;
  const creationTimestamp = logs.length > 0 ? logs[0].timestamp : undefined;
  const inputFile = taskState?.agentConfig.inputFile ?? '';
  const rawAgentName = taskState?.agentConfig.agent ?? id.split('@')[0];
  const agentName = getCleanAgentName(rawAgentName);
  const rawCategory =
    taskState?.agentConfig.session?.agentCategory ?? hints.sessionCategory;

  const sessionCategory = matchesFilter(rawCategory, filter);
  if (sessionCategory === null) {
    return null;
  }

  const agentType =
    taskState?.agentConfig.session?.agentType ??
    taskState?.agentConfig.agentType;
  const isToolAgent = sessionCategory === AgentCategory.ToolUse;
  const isRemote = taskState
    ? isRemoteAgent(rawAgentName)
    : (hints.isRemote ?? false);
  const executionId = state.getExecutionId(id);

  const label =
    sessionCategory !== AgentCategory.ToolUse && inputFile
      ? `${agentName}: ${path.basename(inputFile)}`
      : agentName;

  return {
    name: id,
    label,
    model: taskState?.agentConfig.model,
    agent: taskState?.agentConfig.agent,
    agentType,
    agentSessionKind: sessionCategory,
    uiTraits: { sessionKind: sessionCategory, isToolAgent },
    hasMultipleOutputs: taskState
      ? taskState.agentConfig.useMultipleOutputs
      : (hints.hasMultipleOutputs ?? false),
    isRemote,
    lastTimestamp,
    inputFile,
    creationTimestamp,
    status: statuses?.get(id),
    executionId,
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
