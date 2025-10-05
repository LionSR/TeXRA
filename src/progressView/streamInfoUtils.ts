// Standard library imports
import * as path from 'path';

// Local imports - progress view
import type { ProgressViewState } from './state/ProgressViewState';
import type { AgentFilter, StreamTabInfo } from './types';
// Local imports - agent types
import {
  deriveAgentCategory,
  type AgentCategory,
} from '@agent/core/AgentDataclass';

const sortComparators = {
  time: (a: StreamTabInfo, b: StreamTabInfo) =>
    (b.lastTimestamp ?? b.creationTimestamp ?? 0) -
    (a.lastTimestamp ?? a.creationTimestamp ?? 0),
  inputFile: (a: StreamTabInfo, b: StreamTabInfo) =>
    (a.inputFile || '').localeCompare(b.inputFile || ''),
  agent: (a: StreamTabInfo, b: StreamTabInfo) =>
    (a.agent || '').localeCompare(b.agent || ''),
} as const;

function matchesAgentFilter(
  category: AgentCategory,
  filter: AgentFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'toolUse':
      return category === 'toolUse';
    case 'workflow':
      return category === 'workflow';
    default:
      return true;
  }
}

function buildStreamLabel(
  agentName: string,
  inputFile: string,
  category: AgentCategory,
): string {
  if (category === 'toolUse') {
    return agentName;
  }

  const baseName = inputFile ? path.basename(inputFile) : '';
  return baseName ? `${agentName}: ${baseName}` : agentName;
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
    const sessionKindHint = state.getCategoryHint(id);
    const logs = state.streamTabs.get(id);
    const lastTimestamp =
      logs && logs.length > 0 ? logs[logs.length - 1].timestamp : undefined;
    const creationTimestamp =
      logs && logs.length > 0 ? logs[0].timestamp : undefined;
    const outputs = taskState?.agentConfig.outputFiles || [];
    const inputFile = taskState?.agentConfig.inputFile || '';
    const agentName = taskState?.agentConfig.agent || id.split('@')[0];
    const agentType = taskState?.agentType;
    const agentCategory =
      taskState?.agentCategory ??
      sessionKindHint ??
      deriveAgentCategory(agentType);
    if (!matchesAgentFilter(agentCategory, filter)) {
      return acc;
    }
    const isToolAgent = agentCategory === 'toolUse';
    const executionId = state.getExecutionId(id);
    const label = buildStreamLabel(agentName, inputFile, agentCategory);
    acc.push({
      name: id,
      label,
      model: taskState?.agentConfig.model,
      agent: taskState?.agentConfig.agent,
      agentType,
      agentCategory,
      uiTraits: {
        category: agentCategory,
        isToolAgent,
      },
      hasMultipleOutputs: Array.isArray(outputs) && outputs.length > 1,
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
