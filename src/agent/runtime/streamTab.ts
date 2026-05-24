import { getCleanAgentName } from '@agent/index/agentRegistry';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

/**
 * Build a stream tab ID from an agent, model, and executionId.
 *
 * `executionId` is required: each run gets a unique tab ID, so callers that
 * don't know the executionId cannot refer to any existing tab and should pass
 * an explicit `streamIdOverride` instead of deriving one here.
 */
export function getStreamTabId(
  agent: string,
  model: string,
  options: { executionId: ExecutionId },
): StreamTabId {
  const cleanAgent = getCleanAgentName(agent);
  return `${cleanAgent}@${model}#${options.executionId}`;
}
