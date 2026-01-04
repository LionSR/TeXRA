// Standard library imports
import { randomUUID } from 'crypto';

// Local imports
import { getCleanAgentName, getMultipleName } from '@agent/index';
import { AgentType } from '@agent/core/AgentDataclass';
// Type imports
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

type StreamTabIdOptions = {
  agentType?: AgentType;
  executionId?: ExecutionId;
  useMultipleOutputs?: boolean;
};

function formatToolUseStreamId(
  agent: string,
  model: string,
  executionId?: ExecutionId,
): StreamTabId {
  const shortId = executionId?.slice(0, 8) ?? randomUUID().slice(0, 8);
  const sanitizedAgent = agent ?? 'toolUse';
  return `${sanitizedAgent}@${model}#${shortId}`;
}

/**
 * Build a consistent stream tab identifier based on agent, model and input file.
 * This identifier is used for UI tabs and execution deduplication.
 */
export function getStreamTabId(
  agent: string,
  model: string,
  inputFile: string,
  options: StreamTabIdOptions = {},
): StreamTabId {
  // Sanitize agent name by extracting clean name from source:name format
  const cleanAgent = getCleanAgentName(agent);

  if (options.agentType === AgentType.ToolUse) {
    return formatToolUseStreamId(cleanAgent, model, options.executionId);
  }

  const agentName = options.useMultipleOutputs
    ? getMultipleName(cleanAgent)
    : cleanAgent;
  // Use full workspace-relative path for deduplication to distinguish files with same name
  // in different directories. Normalize backslashes to forward slashes for consistent IDs
  // across platforms and to avoid issues with CSS attribute selectors where backslashes
  // are treated as escape characters.
  const filePath = (inputFile ?? '').replaceAll('\\', '/');
  return `${agentName}@${model}: ${filePath}`;
}
