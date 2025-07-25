import * as path from 'path';
import type { ProgressViewState } from './state/ProgressViewState';
import type { StreamTabInfo } from './types';

/**
 * Build metadata objects for all streams in the given state.
 */
export function buildStreamInfos(state: ProgressViewState): StreamTabInfo[] {
  return state.streamTabs.keys().map((id) => {
    const taskState = state.getTaskState(id);
    const logs = state.streamTabs.get(id);
    const lastTimestamp =
      logs && logs.length > 0 ? logs[logs.length - 1].timestamp : undefined;
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
    };
  });
}
