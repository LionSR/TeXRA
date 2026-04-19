import { getCleanAgentName, getMultipleName } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';

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
  const shortId = options.executionId ?? generateExecutionId();

  if (options.agentCategory === AgentCategory.ToolUse) {
    return `${cleanAgent}@${model}#${shortId}`;
  }

  const agentName = options.useMultipleOutputs
    ? getMultipleName(cleanAgent)
    : cleanAgent;
  const inputPart = inputFile
    ? `: ${inputFile.replaceAll('\\', '/')}`
    : '';
  return `${agentName}@${model}#${shortId}${inputPart}`;
}
