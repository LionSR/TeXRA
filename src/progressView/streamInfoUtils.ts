import * as path from 'path';

import { getCleanAgentName, isRemoteAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentCategoryFilter, StreamTabInfo } from '@shared/schemas';
import { sortStreams } from '@shared/streams/streamSort';
import type { ProgressViewState } from './state/ProgressViewState';

/**
 * Check if a session category matches the given filter.
 * Returns the resolved category (defaulting to Workflow) or null if filtered out.
 */
function matchesFilter(
  category: AgentCategory | undefined,
  filter: AgentCategoryFilter,
): AgentCategory | null {
  const resolved = category ?? AgentCategory.Workflow;

  if (filter === 'all') {
    return resolved;
  }

  const expected =
    filter === 'toolUse' ? AgentCategory.ToolUse : AgentCategory.Workflow;

  return resolved === expected ? resolved : null;
}

/**
 * Build a StreamTabInfo object for a single stream ID.
 * Returns null if the stream doesn't match the filter.
 */
function buildStreamInfo(
  state: ProgressViewState,
  id: string,
  filter: AgentCategoryFilter,
): StreamTabInfo | null {
  const taskState = state.meta.getTaskState(id);
  const hints = state.getStreamHints(id);
  const config = taskState?.agentConfig;

  // Determine category and check filter
  const rawCategory = config?.agentCategory ?? hints.agentCategory;
  const category = matchesFilter(rawCategory, filter);
  if (category === null) return null;

  const creationTimestamp =
    state.streamLogs.getFirstTimestamp(id) ??
    hints.creationTimestamp ??
    Date.now();

  // Agent and file info (with fallbacks to hints)
  const inputFile = config?.inputFile ?? '';
  const rawAgentName = config?.agent ?? id.split('@')[0];
  const agentName = getCleanAgentName(rawAgentName);

  // Build display label (workflow agents show input file, tool-use agents don't)
  const label =
    category !== AgentCategory.ToolUse && inputFile
      ? `${agentName}: ${path.basename(inputFile)}`
      : agentName;

  // `bash` child streams carry a synthetic AgentConfig whose `model` is the
  // schema's prefault, not a model actually used for inference. Hide it so
  // the tab doesn't display a misleading model label.
  const isBashSession = config?.agent === 'bash';

  return {
    name: id,
    label,
    model: isBashSession ? undefined : config?.model,
    agent: config?.agent,
    agentCategory: category,
    hasMultipleOutputs:
      config?.useMultipleOutputs ?? hints.hasMultipleOutputs ?? false,
    isRemote: taskState
      ? isRemoteAgent(rawAgentName)
      : (hints.isRemote ?? false),
    inputFile,
    creationTimestamp,
    executionId: state.meta.getExecutionId(id),
    parentStreamId: state.meta.getParentStreamId(id),
    description: state.meta.getDescription(id),
  };
}

/**
 * Build metadata objects for all streams in the given state.
 */
export function buildStreamInfos(
  state: ProgressViewState,
  filter: AgentCategoryFilter = 'all',
): StreamTabInfo[] {
  const infos = state.streamLogs
    .keys()
    .map((id) => buildStreamInfo(state, id, filter))
    .filter((info): info is StreamTabInfo => info !== null);

  return sortStreams(infos, state.streamSortOrder, {
    getLastActivityTimestamp: (stream) =>
      state.streamLogs.getLastTimestamp(stream.name),
  });
}
