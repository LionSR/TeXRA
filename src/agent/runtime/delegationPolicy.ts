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
 * Recover the delegation depth for a persisted execution by walking the
 * parentExecutionId chain in its metadata. Used on resume, where the
 * in-memory depth that executeAgent would normally carry is unavailable.
 *
 * Returns 0 when no parent is stored (root execution or pre-feature data)
 * or if a cycle is detected defensively.
 */
export async function computeDelegationDepthFromStorage(
  executionId: ExecutionId,
): Promise<number> {
  const visited = new Set<string>();
  let current: ExecutionId | undefined = executionId;
  let depth = 0;
  // Cap the walk as a belt-and-suspenders against corrupted chains.
  const MAX_WALK = 32;
  while (current && !visited.has(current) && depth < MAX_WALK) {
    visited.add(current);
    const meta: ExecutionMeta | null = await getExecutionStore(
      current,
    ).readMeta();
    const parent: ExecutionId | undefined = meta?.parentExecutionId;
    if (!parent) break;
    depth++;
    current = parent;
  }
  return depth;
}
