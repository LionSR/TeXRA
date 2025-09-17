// Standard library imports
import { randomUUID } from 'crypto';
import * as path from 'path';

// Local imports
import { AgentType } from '@agent/core/AgentDataclass';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

type StreamTabIdOptions = {
  agentType?: AgentType;
  executionId?: ExecutionId;
};

function formatToolUseStreamId(
  agent: string,
  model: string,
  executionId?: ExecutionId,
): StreamTabId {
  const shortId = executionId?.slice(0, 8) ?? randomUUID().slice(0, 8);
  const sanitizedAgent = agent || 'toolUse';
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
  outputFiles?: string[] | null,
  options: StreamTabIdOptions = {},
): StreamTabId {
  if (options.agentType === AgentType.ToolUse) {
    return formatToolUseStreamId(agent, model, options.executionId);
  }

  const hasMultipleOutputs = Boolean(outputFiles && outputFiles.length > 1);
  const agentName = hasMultipleOutputs
    ? agent.endsWith('_multiple')
      ? agent
      : `${agent}_multiple`
    : agent;
  const baseName = inputFile ? path.basename(inputFile) : '';
  return `${agentName}@${model}: ${baseName}`;
}
