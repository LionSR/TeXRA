// Standard library imports
import * as path from 'path';

// Local imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';

type StreamTabIdOptions = {
  agentType?: string;
  executionId?: string;
};

function formatToolUseStreamId(
  agent: string,
  model: string,
  executionId?: string,
): StreamTabId {
  const shortId = executionId
    ? executionId.slice(0, 8)
    : Date.now().toString(36);
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
  if (options.agentType === 'toolUse') {
    return formatToolUseStreamId(agent, model, options.executionId);
  }

  const agentName =
    outputFiles && outputFiles.length > 1 ? `${agent}_multiple` : agent;
  const baseName = inputFile ? path.basename(inputFile) : '';
  return `${agentName}@${model}: ${baseName}`;
}
