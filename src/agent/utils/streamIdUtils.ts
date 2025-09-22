// Local imports
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentType } from '@agent/core/AgentDataclass';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
import { getStreamTabId } from '@/logger/streamUtils';

/**
 * Compute stream tab ID for an agent execution.
 * This utility centralizes the logic for computing stream IDs,
 * avoiding duplication across executeAgent and resumeCommand.
 */
export function computeStreamTabId(
  config: Pick<AgentConfig, 'agent' | 'model' | 'inputFile' | 'useMultipleOutputs'>,
  agentType: AgentType,
  executionId?: ExecutionId,
): StreamTabId {
  return getStreamTabId(config.agent, config.model, config.inputFile, {
    agentType,
    executionId,
    useMultipleOutputs: config.useMultipleOutputs,
  });
}