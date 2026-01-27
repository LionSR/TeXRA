import { randomUUID } from 'crypto';

import { getCleanAgentName, getMultipleName } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

interface StreamTabIdOptions {
  agentCategory?: AgentCategory;
  executionId?: ExecutionId;
  useMultipleOutputs?: boolean;
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
  const cleanAgent = getCleanAgentName(agent);

  // Tool-use agents use execution ID for deduplication
  if (options.agentCategory === AgentCategory.ToolUse) {
    const shortId =
      options.executionId?.slice(0, 8) ?? randomUUID().slice(0, 8);
    return `${cleanAgent ?? 'toolUse'}@${model}#${shortId}`;
  }

  // Workflow agents use file path for deduplication
  const agentName = options.useMultipleOutputs
    ? getMultipleName(cleanAgent)
    : cleanAgent;
  // Normalize backslashes for consistent IDs across platforms and CSS selectors
  const filePath = (inputFile ?? '').replaceAll('\\', '/');
  return `${agentName}@${model}: ${filePath}`;
}
