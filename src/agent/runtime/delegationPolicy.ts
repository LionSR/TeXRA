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
import { WorkspaceStateKey } from '@common/state/stateKeys';
import type { ExecutionId } from '@shared/schemas';
import {
  clampNestedDelegationDepth,
  type NestedDelegationConfig,
  UNKNOWN_DELEGATION_DEPTH,
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
const UNKNOWN_DEPTH_SENTINEL = UNKNOWN_DELEGATION_DEPTH;

/**
 * Read meta without letting filesystem/IO errors bubble up — safeParse
 * already handles malformed JSON by returning null, but the underlying
 * storage layer can throw on permission or IO failures. Resume must
 * not hard-fail on a single corrupted ancestor.
 */
async function readMetaSafely(
  executionId: ExecutionId,
): Promise<ExecutionMeta | null | 'error'> {
  try {
    return await getExecutionStore(executionId).readMeta();
  } catch {
    return 'error';
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
 * `UNKNOWN_DEPTH_SENTINEL`. A valid resumable snapshot always has a valid
 * `meta.json`, so `null` here is corruption, not a legitimate root. Treating
 * it as depth 0 would let a broken-meta subagent bypass the delegation gate.
 * Resume itself still succeeds on the surviving message snapshot; the LLM
 * just can't delegate from that session.
 */
export async function computeDelegationDepthFromStorage(
  executionId: ExecutionId,
): Promise<number> {
  const rootMeta = await readMetaSafely(executionId);
  if (rootMeta === 'error' || rootMeta === null) return UNKNOWN_DEPTH_SENTINEL;
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
    if (visited.has(current)) return UNKNOWN_DEPTH_SENTINEL; // cycle
    visited.add(current);
    const meta = await readMetaSafely(current);
    if (meta === 'error' || meta === null) return UNKNOWN_DEPTH_SENTINEL;
    if (meta.delegationDepth !== undefined) return meta.delegationDepth + depth;
    const parent: ExecutionId | undefined = meta.parentExecutionId;
    if (!parent) return depth; // clean terminus
    depth++;
    current = parent;
  }
  // MAX_WALK exceeded: chain longer than any legitimate depth — treat as corrupt.
  return UNKNOWN_DEPTH_SENTINEL;
}
