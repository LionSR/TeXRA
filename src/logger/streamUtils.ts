// Standard library imports
import * as path from 'path';

// Local imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { AgentType } from '@agent/core/AgentDataclass';

const TOOL_USE_LABEL = 'Session';

function formatToolUseSuffix(sequence: number): string {
  return `#${sequence.toString().padStart(2, '0')}`;
}

/**
 * Build a consistent stream tab identifier based on agent, model and input file.
 * This identifier is used for UI tabs and execution deduplication.
 */
export function getStreamTabId(
  agent: string,
  model: string,
  inputFile: string,
  outputFiles?: string[],
  agentType: AgentType = AgentType.CoT,
  toolUseSequence?: number,
): StreamTabId {
  const agentName =
    outputFiles && outputFiles.length > 1 ? `${agent}_multiple` : agent;

  if (agentType === AgentType.ToolUse) {
    const suffix = formatToolUseSuffix(toolUseSequence ?? 1);
    return `${agentName}@${model}${suffix}`;
  }

  return `${agentName}@${model}: ${path.basename(inputFile)}`;
}

/**
 * Format a human-friendly label for tool-use sessions.
 */
export function getToolUseSessionLabel(sequence: number): string {
  return `${TOOL_USE_LABEL} ${sequence}`;
}
