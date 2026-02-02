import { randomUUID } from 'crypto';

import { getCleanAgentName, getMultipleName } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export function getStreamTabId(
  agent: string,
  model: string,
  inputFile: string,
  options: {
    agentCategory?: AgentCategory;
    executionId?: ExecutionId;
    useMultipleOutputs?: boolean;
  } = {},
): StreamTabId {
  const cleanAgent = getCleanAgentName(agent);

  if (options.agentCategory === AgentCategory.ToolUse) {
    const shortId =
      options.executionId?.slice(0, 8) ?? randomUUID().slice(0, 8);
    return `${cleanAgent}@${model}#${shortId}`;
  }

  const agentName = options.useMultipleOutputs
    ? getMultipleName(cleanAgent)
    : cleanAgent;
  return `${agentName}@${model}: ${inputFile.replaceAll('\\', '/')}`;
}
