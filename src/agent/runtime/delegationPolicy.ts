/**
 * Agent-side nested-delegation depth recovery. Walks the persisted
 * parent-execution chain to recover a subagent's delegation depth on
 * resume, for observability (CLI history, trace metadata) and for
 * `isSubagent` detection — not for any depth cap. Kept here (not in a
 * flow-specific file) so the tool layer and resume path can import it
 * without creating a cycle back through the tool registry.
 */

import { getExecutionStore } from '@agent/storage';
import type { ExecutionMeta } from '@agent/storage/ExecutionKVStore';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Read meta without letting filesystem/IO errors bubble up. `readMeta`
 * already maps malformed JSON to null, and an IO/permission throw maps to
 * null here too: both are unreadable lineage, so the caller treats null
 * uniformly. Log the IO case so an unreadable ancestor isn't invisible.
 */
async function readMetaSafely(
  executionId: ExecutionId,
): Promise<ExecutionMeta | null> {
  try {
    return await getExecutionStore(executionId).readMeta();
  } catch (err) {
    logger.warn(
      'DelegationPolicy',
      `Failed to read execution meta for ${executionId}: ${toErrorMessage(
        err,
      )}`,
    );
    return null;
  }
}

/**
 * Recover the delegation depth for a persisted execution on resume, where
 * the in-memory depth that executeAgent would normally carry is unavailable.
 *
 * Preferred source is `meta.delegationDepth`, written at register-time by
 * `DelegationTools.executeSubagent`. Falls back to walking the
 * `parentExecutionId` chain for pre-feature snapshots that don't have the
 * field persisted yet.
 *
 * Best-effort: any corrupted, unreadable, or missing meta in the lineage —
 * including a cycle or an excessively long chain — falls back to depth 0
 * (treated as a root). Resume itself still succeeds on the surviving message
 * snapshot regardless.
 */
export async function computeDelegationDepthFromStorage(
  executionId: ExecutionId,
): Promise<number> {
  const rootMeta = await readMetaSafely(executionId);
  if (rootMeta === null) return 0;
  if (rootMeta.delegationDepth !== undefined) return rootMeta.delegationDepth;
  if (!rootMeta.parentExecutionId) return 0;

  // Legacy fallback: walk the chain for snapshots created before
  // delegationDepth was persisted.
  const visited = new Set<string>([executionId]);
  let current: ExecutionId | undefined = rootMeta.parentExecutionId;
  let depth = 1;
  const MAX_WALK = 32;
  while (depth < MAX_WALK) {
    if (!current) return depth; // clean terminus
    if (visited.has(current)) return 0; // cycle
    visited.add(current);
    const meta = await readMetaSafely(current);
    if (meta === null) return 0;
    if (meta.delegationDepth !== undefined) return meta.delegationDepth + depth;
    const parent: ExecutionId | undefined = meta.parentExecutionId;
    if (!parent) return depth; // clean terminus
    depth++;
    current = parent;
  }
  // MAX_WALK exceeded: chain longer than any legitimate depth — treat as corrupt.
  return 0;
}
