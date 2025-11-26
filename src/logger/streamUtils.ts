// Standard library imports
import { randomUUID } from 'crypto';
import * as path from 'path';

// Local imports
import { AgentType } from '@agent/core/AgentDataclass';
import { RemoteAgentRegistry } from '@agent/remote/RemoteAgentRegistry';
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
  // Sanitize agent name by removing remote:// prefix to avoid file path issues
  const cleanAgent = RemoteAgentRegistry.getCleanName(agent);

  if (options.agentType === AgentType.ToolUse) {
    return formatToolUseStreamId(cleanAgent, model, options.executionId);
  }

  const agentName = options.useMultipleOutputs
    ? cleanAgent.endsWith('_multiple')
      ? cleanAgent
      : `${cleanAgent}_multiple`
    : cleanAgent;
  const baseName = inputFile ? path.basename(inputFile) : '';
  return `${agentName}@${model}: ${baseName}`;
}
