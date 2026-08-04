import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { getCleanAgentName } from '@shared/schemas/agent';

/**
 * Mint the opaque stream tab id for a new run: `${name}#${executionId}`.
 *
 * The id is an opaque handle — nothing parses it back. Uniqueness comes from
 * the executionId suffix; the name prefix is human-orienting only. Existing
 * runs are addressed by the `streamId` stamped on their execution metadata
 * at registration, never by re-deriving this format.
 */
export function getStreamTabId(
  agent: string,
  options: { executionId: ExecutionId },
): StreamTabId {
  return `${getCleanAgentName(agent)}#${options.executionId}`;
}
