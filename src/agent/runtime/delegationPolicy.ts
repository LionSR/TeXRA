/**
 * Agent-side nested-delegation helpers. Reads workspace state and
 * walks the persisted parent-execution chain to recover delegation
 * depth on resume. Kept here (not in a flow-specific file) so the
 * tool layer and resume path can import it without creating a cycle
 * back through the tool registry.
 */

import { platform } from '@platform/platform';
import { getExecutionStore } from '@agent/storage';
import type { ExecutionMeta } from '@agent/storage/ExecutionKVStore';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  clampNestedDelegationDepth,
  evaluateDelegationGate,
  type DelegationGateResult,
  type NestedDelegationConfig,
  UNKNOWN_DELEGATION_DEPTH,
} from '@shared/constants/delegationPolicy';

/** Read the current delegation policy from workspace state. */
function readNestedDelegationConfig(): NestedDelegationConfig {
  const state = platform().workspaceState;
  const maxDepth = clampNestedDelegationDepth(
    state.get<number>(WorkspaceStateKey.NESTED_DELEGATION_MAX_DEPTH, undefined),
  );
  return { maxDepth };
}

/** Evaluate the delegation gate against the current workspace policy. */
export function evaluateCurrentDelegationGate(
  depth: number,
): DelegationGateResult {
  return evaluateDelegationGate(depth, readNestedDelegationConfig());
}

/**
 * Read meta without letting filesystem/IO errors bubble up. `readMeta`
 * already maps malformed JSON to null, and an IO/permission throw maps to
 * null here too: both are unreadable lineage that must fail closed, so the
 * caller treats null uniformly. Log the IO case so an unreadable ancestor
 * isn't an invisible cause of blocked delegation.
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
 * Fail-closed: any corrupted, unreadable, or missing meta in the lineage —
 * including the resumed execution's own meta — returns
 * `UNKNOWN_DELEGATION_DEPTH`. A valid resumable snapshot always has a valid
 * `meta.json`, so `null` here is corruption, not a legitimate root. Treating
 * it as depth 0 would let a broken-meta subagent bypass the delegation gate.
 * Resume itself still succeeds on the surviving message snapshot; the LLM
 * just can't delegate from that session.
 */
export async function computeDelegationDepthFromStorage(
  executionId: ExecutionId,
): Promise<number> {
  const rootMeta = await readMetaSafely(executionId);
  if (rootMeta === null) return UNKNOWN_DELEGATION_DEPTH;
  if (rootMeta.delegationDepth !== undefined) return rootMeta.delegationDepth;
  if (!rootMeta.parentExecutionId) return 0;

  // Legacy fallback: walk the chain for snapshots created before
  // delegationDepth was persisted. All loop-exit corruption signals
  // (cycle, MAX_WALK) fail closed via the sentinel; only a clean walk
  // that terminates at a root (no parentExecutionId) returns the depth.
  const visited = new Set<string>([executionId]);
  let current: ExecutionId | undefined = rootMeta.parentExecutionId;
  let depth = 1;
  const MAX_WALK = 32;
  while (depth < MAX_WALK) {
    if (!current) return depth; // clean terminus
    if (visited.has(current)) return UNKNOWN_DELEGATION_DEPTH; // cycle
    visited.add(current);
    const meta = await readMetaSafely(current);
    if (meta === null) return UNKNOWN_DELEGATION_DEPTH;
    if (meta.delegationDepth !== undefined) return meta.delegationDepth + depth;
    const parent: ExecutionId | undefined = meta.parentExecutionId;
    if (!parent) return depth; // clean terminus
    depth++;
    current = parent;
  }
  // MAX_WALK exceeded: chain longer than any legitimate depth — treat as corrupt.
  return UNKNOWN_DELEGATION_DEPTH;
}
