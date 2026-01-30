// Standard library imports
import * as path from 'path';

// Local imports - shared schemas
import { sortStreams, type StreamSort } from '@shared/streams/streamSort';

// Local imports - progress view
import { getCleanAgentName, isRemoteAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentCategoryFilter, StreamTabInfo } from '@shared/schemas';

// Type imports
import type { ProgressViewState } from './state/ProgressViewState';

/**
 * Check if a session category matches the given filter.
 * Returns the category to use (defaulting to Workflow) or null if filtered out.
 */
function matchesFilter(
  category: AgentCategory | undefined,
  filter: AgentCategoryFilter,
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
  filter: AgentCategoryFilter,
): StreamTabInfo | null {
  const taskState = state.getTaskState(id);
  const hints = state.getStreamHints(id);
  const config = taskState?.agentConfig;

  // Determine category and check filter
  const rawCategory = config?.agentCategory ?? hints.agentCategory;
  const category = matchesFilter(rawCategory, filter);
  if (category === null) return null;

  // Extract timestamps directly (avoids copying entire messages array)
  const lastTimestamp = state.streamTabs.getLastTimestamp(id);
  const creationTimestamp = state.streamTabs.getFirstTimestamp(id);

  // Agent and file info (with fallbacks to hints)
  const inputFile = config?.inputFile ?? '';
  const rawAgentName = config?.agent ?? id.split('@')[0];
  const agentName = getCleanAgentName(rawAgentName);

  // Build display label (workflow agents show input file, tool-use agents don't)
  const label =
    category !== AgentCategory.ToolUse && inputFile
      ? `${agentName}: ${path.basename(inputFile)}`
      : agentName;

  return {
    name: id,
    label,
    model: config?.model,
    agent: config?.agent,
    agentCategory: category,
    hasMultipleOutputs:
      config?.useMultipleOutputs ?? hints.hasMultipleOutputs ?? false,
    isRemote: taskState
      ? isRemoteAgent(rawAgentName)
      : (hints.isRemote ?? false),
    lastTimestamp,
    inputFile,
    creationTimestamp,
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
  filter: AgentCategoryFilter = 'all',
): StreamTabInfo[] {
  const infos = state.streamTabs
    .keys()
    .map((id) => buildStreamInfo(state, id, statuses, filter))
    .filter((info): info is StreamTabInfo => info !== null);

  return sortStreams(infos, state.streamSortOrder as StreamSort);
}
