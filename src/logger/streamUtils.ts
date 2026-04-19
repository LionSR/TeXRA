import { getCleanAgentName } from '@agent/index';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';

export function getStreamTabId(
  agent: string,
  model: string,
  options: {
    executionId?: ExecutionId;
  } = {},
): StreamTabId {
  const cleanAgent = getCleanAgentName(agent);
  const shortId = options.executionId ?? generateExecutionId();
  return `${cleanAgent}@${model}#${shortId}`;
}
