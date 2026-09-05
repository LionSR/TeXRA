import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { getCleanAgentName } from '@shared/schemas';

/**
 * Mint the opaque stream tab id for a new run: `${name}#${executionId}`.
 *
 * Single owner of the format for every run that gets a tab: a native run
 * passes its agent identifier, a child run launched by a tool passes that
 * tool's stream prefix (e.g. {@link BASH_CHILD_STREAM_PREFIX}). Disjoint
 * namespaces share one wire format. `getCleanAgentName` normalizes an
 * `<source>:<agent>` identifier
 * and returns anything else, tool prefixes included, unchanged.
 *
 * The id is an opaque handle — nothing parses it back to address a run.
 * Uniqueness comes from the executionId suffix; the name prefix is
 * human-orienting only. Existing runs are addressed by the `streamId` stamped
 * on their execution metadata at registration, never by re-deriving this
 * format.
 */
export function getStreamTabId(
  name: string,
  options: { executionId: ExecutionId },
): StreamTabId {
  return `${getCleanAgentName(name)}#${options.executionId}`;
}

/** Stream-id prefix minted for a background shell child (`src/tools/bash.ts`). */
export const BASH_CHILD_STREAM_PREFIX = 'bash@tool';
