// Standard library imports
import * as path from 'path';

// Local imports - progress view
import { getCleanAgentName, isRemoteAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';

// Type imports
import type { ProgressViewState } from './state/ProgressViewState';
import type { AgentFilter, StreamTabInfo } from './types';

const sortComparators = {
  time: (a: StreamTabInfo, b: StreamTabInfo) =>
    (b.lastTimestamp ?? b.creationTimestamp ?? 0) -
    (a.lastTimestamp ?? a.creationTimestamp ?? 0),
  inputFile: (a: StreamTabInfo, b: StreamTabInfo) =>
    (a.inputFile ?? '').localeCompare(b.inputFile ?? ''),
  agent: (a: StreamTabInfo, b: StreamTabInfo) =>
    (a.agent ?? '').localeCompare(b.agent ?? ''),
} as const;

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
    let sessionCategory =
      taskState?.agentConfig.session?.agentCategory ?? hints.sessionCategory;

    // Filter logic: streams without category only show when filter is "all"
    if (!sessionCategory) {
      if (filter !== 'all') {
        return acc;
      }
      // Default to Workflow for display purposes only when filter is "all"
      sessionCategory = AgentCategory.Workflow;
    } else {
      // Inline filter matching: check if session category matches filter
      const matchesFilter =
        filter === 'all' ||
        (filter === 'toolUse' && sessionCategory === AgentCategory.ToolUse) ||
        (filter === 'workflow' && sessionCategory === AgentCategory.Workflow);
      if (!matchesFilter) {
        return acc;
      }
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
    const label =
      sessionCategory === AgentCategory.ToolUse
        ? agentName
        : inputFile
          ? `${agentName}: ${path.basename(inputFile)}`
          : agentName;
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

  const comparator =
    sortComparators[state.streamSortOrder as keyof typeof sortComparators];
  if (comparator) {
    infos.sort(comparator);
  }

  return infos;
}
