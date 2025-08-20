// Standard library imports
import * as path from 'path';

// Local imports - progress view
import type { ProgressViewState } from './state/ProgressViewState';
import type { StreamTabInfo } from './types';

const sortComparators = {
  time: (a: StreamTabInfo, b: StreamTabInfo) =>
    (b.lastTimestamp ?? b.creationTimestamp ?? 0) -
    (a.lastTimestamp ?? a.creationTimestamp ?? 0),
  inputFile: (a: StreamTabInfo, b: StreamTabInfo) =>
    (a.inputFile || '').localeCompare(b.inputFile || ''),
  agent: (a: StreamTabInfo, b: StreamTabInfo) =>
    (a.agent || '').localeCompare(b.agent || ''),
} as const;

/**
 * Build metadata objects for all streams in the given state.
 */
export function buildStreamInfos(
  state: ProgressViewState,
  statuses?: Map<string, string>,
): StreamTabInfo[] {
  const infos = state.streamTabs.keys().map((id) => {
    const taskState = state.getTaskState(id);
    const logs = state.streamTabs.get(id);
    const lastTimestamp =
      logs && logs.length > 0 ? logs[logs.length - 1].timestamp : undefined;
    const creationTimestamp =
      logs && logs.length > 0 ? logs[0].timestamp : undefined;
    const outputs = taskState?.agentConfig.outputFiles || [];
    const inputFile = taskState?.agentConfig.inputFile || '';
    const agentName = taskState?.agentConfig.agent || id.split('@')[0];
    const label = `${agentName}: ${path.basename(inputFile)}`;
    return {
      name: id,
      label,
      model: taskState?.agentConfig.model,
      agent: taskState?.agentConfig.agent,
      agentType: taskState?.agentType,
      hasMultipleOutputs: Array.isArray(outputs) && outputs.length > 1,
      lastTimestamp,
      inputFile,
      creationTimestamp,
      status: statuses?.get(id),
    } as StreamTabInfo;
  });

  const comparator =
    sortComparators[state.streamSortOrder as keyof typeof sortComparators];
  if (comparator) {
    infos.sort(comparator);
  }

  return infos;
}
