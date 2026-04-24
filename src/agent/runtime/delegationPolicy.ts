/**
 * Agent-side nested-delegation helpers. Reads workspace state and
 * walks the persisted parent-execution chain to recover delegation
 * depth on resume. Kept here (not in a flow-specific file) so the
 * tool layer and resume path can import it without creating a cycle
 * back through the tool registry.
 */

import { getExecutionStore } from '@agent/storage';
import type { ExecutionMeta } from '@agent/storage/ExecutionKVStore';
import { getWorkspaceState } from '@agent/core/stateStore';
import { WorkspaceStateKey } from '@common/state';
import type { ExecutionId } from '@shared/schemas';
import {
  clampNestedDelegationDepth,
  type NestedDelegationConfig,
} from '@shared/constants/delegationPolicy';

/** Read the current delegation policy from workspace state. */
export function readNestedDelegationConfig(): NestedDelegationConfig {
  const state = getWorkspaceState();
  const maxDepth = clampNestedDelegationDepth(
    state.get<number>(WorkspaceStateKey.NESTED_DELEGATION_MAX_DEPTH, undefined),
  );
  return { maxDepth };
}

/**
 * Sentinel returned when a resumed snapshot's lineage can't be trusted
 * (e.g. an ancestor's meta was deleted while a descendant survived).
 * `delegationAllowed(MAX_SAFE_INTEGER, { maxDepth })` is false for any
 * configured cap, so delegation is conservatively blocked.
 */
const UNKNOWN_DEPTH_SENTINEL = Number.MAX_SAFE_INTEGER;

/**
 * Recover the delegation depth for a persisted execution on resume, where
 * the in-memory depth that executeAgent would normally carry is unavailable.
 *
 * Preferred source is `meta.delegationDepth`, written at register-time by
 * `DelegationTools.executeSubagent`. Falls back to walking the
 * `parentExecutionId` chain for pre-feature snapshots that don't have the
 * field persisted yet.
 *
 * Returns 0 when no parent is stored (root execution) or the persisted
 * depth is 0. Returns `UNKNOWN_DEPTH_SENTINEL` when the chain walk encounters
 * a missing ancestor mid-chain — we can't safely undercount, so callers
 * will see it as past the cap.
 */
export async function computeDelegationDepthFromStorage(
  executionId: ExecutionId,
): Promise<number> {
  const rootMeta = await getExecutionStore(executionId).readMeta();
  if (!rootMeta) return 0;
  if (rootMeta.delegationDepth !== undefined) return rootMeta.delegationDepth;
  if (!rootMeta.parentExecutionId) return 0;

  // Legacy fallback: walk the chain for snapshots created before
  // delegationDepth was persisted.
  const visited = new Set<string>([executionId]);
  let current: ExecutionId | undefined = rootMeta.parentExecutionId;
  let depth = 1;
  const MAX_WALK = 32;
  while (current && !visited.has(current) && depth < MAX_WALK) {
    visited.add(current);
    const meta: ExecutionMeta | null = await getExecutionStore(
      current,
    ).readMeta();
    // Ancestor meta missing or corrupted: we can't tell how deep we are.
    // Return a sentinel that fails the gate for any configured cap.
    if (!meta) return UNKNOWN_DEPTH_SENTINEL;
    if (meta.delegationDepth !== undefined) return meta.delegationDepth + depth;
    const parent: ExecutionId | undefined = meta.parentExecutionId;
    if (!parent) break;
    depth++;
    current = parent;
  }
  return depth;
}
