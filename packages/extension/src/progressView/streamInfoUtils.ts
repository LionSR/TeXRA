import * as path from 'path';

import { MODEL_CONFIGS } from 'llm-zoo';

import { getCleanAgentName, isRemoteAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentCategoryFilter, StreamTabInfo } from '@shared/schemas';
import { isProcessAgent } from '@shared/streams/agentKind';
import { compareByNewestCreationTime } from './streamOrdering';
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
export function buildStreamInfo(
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

  // Process agents (e.g. bash) carry a synthetic AgentConfig whose `model` is
  // the schema's prefault, not a model actually used for inference — omit it
  // so the tab doesn't display a misleading label.
  const processAgent = isProcessAgent(config?.agent);

  // For process streams, config.instruction holds the full command (set by
  // bash.ts when registering the child stream). Expose it untruncated so the
  // process stream view can display the exact command, while `description`
  // stays capped for tab/tooltip rendering. AgentConfigSchema prefaults
  // instruction to '' — normalise empty to undefined so nullish-coalescing
  // fallbacks work as intended downstream.
  const rawInstruction = processAgent ? config?.instruction : undefined;
  const command = rawInstruction ? rawInstruction : undefined;

  return {
    name: id,
    label,
    model: processAgent ? undefined : config?.model,
    modelLabel:
      !processAgent && config?.model
        ? (MODEL_CONFIGS[config.model]?.label ?? config.model)
        : undefined,
    agent: config?.agent,
    agentCategory: category,
    isRemote: taskState
      ? isRemoteAgent(rawAgentName)
      : (hints.isRemote ?? false),
    inputFile,
    creationTimestamp,
    executionId: state.meta.getExecutionId(id),
    parentStreamId: state.meta.getParentStreamId(id),
    description: state.meta.getDescription(id),
    command,
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

  return infos.sort(compareByNewestCreationTime);
}
