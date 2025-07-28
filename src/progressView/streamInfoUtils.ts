import * as path from 'path';
import type { ProgressViewState } from './state/ProgressViewState';
import type { StreamTabInfo } from './types';
import { getConfig } from '@utils/config';

/**
 * Build metadata objects for all streams in the given state.
 */
export function buildStreamInfos(state: ProgressViewState): StreamTabInfo[] {
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
    } as StreamTabInfo;
  });

  const sortBy = getConfig<string>('progressView.sortStreamsBy', 'none');
  switch (sortBy) {
    case 'lastActive':
      infos.sort((a, b) => (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0));
      break;
    case 'inputFile':
      infos.sort((a, b) =>
        (a.inputFile || '').localeCompare(b.inputFile || ''),
      );
      break;
    case 'agent':
      infos.sort((a, b) => (a.agent || '').localeCompare(b.agent || ''));
      break;
    default:
      break;
  }

  return infos;
}
