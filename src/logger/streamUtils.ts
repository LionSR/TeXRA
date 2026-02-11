import { getCleanAgentName, getMultipleName } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { generateExecutionId } from '@utils/core/executionId';
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
      options.executionId?.slice(0, 8) ?? generateExecutionId().slice(0, 8);
    return `${cleanAgent}@${model}#${shortId}`;
  }

  const agentName = options.useMultipleOutputs
    ? getMultipleName(cleanAgent)
    : cleanAgent;
  return `${agentName}@${model}: ${inputFile.replaceAll('\\', '/')}`;
}
