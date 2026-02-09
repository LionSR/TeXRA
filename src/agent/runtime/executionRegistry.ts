/**
 * Execution registry with parent-child lineage for active agent executions.
 *
 * Tracks executionId → streamId mappings and parent-child relationships.
 * Enables cascading interrupt: when a parent is interrupted, all descendant
 * executions are interrupted too.
 *
 * Used by:
 * - executeAgent (track/untrack on start/end)
 * - RunsTool (look up stream status for an execution)
 * - agentCommands (cascading interrupt via interruptWithDescendants)
 */

import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import type { StreamTabId } from '@shared/schemas';

// ---------------------------------------------------------------------------
// Core registry
// ---------------------------------------------------------------------------

interface ExecutionEntry {
  streamId: StreamTabId;
  parentExecutionId?: string;
}

const registry = new Map<string, ExecutionEntry>();

/** Index: parentExecutionId → set of child executionIds. */
const children = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Track / Untrack
// ---------------------------------------------------------------------------

/**
 * Track an active execution, optionally linking it to a parent.
 *
 * @param executionId - Unique ID for this execution
 * @param streamId - Stream tab ID associated with this execution
 * @param parentExecutionId - If this is a subagent, the parent's execution ID
 */
export function trackExecution(
  executionId: string,
  streamId: StreamTabId,
  parentExecutionId?: string,
): void {
  registry.set(executionId, { streamId, parentExecutionId });

  if (parentExecutionId) {
    let childSet = children.get(parentExecutionId);
    if (!childSet) {
      childSet = new Set();
      children.set(parentExecutionId, childSet);
    }
    childSet.add(executionId);
  }
}

/** Remove a completed execution and clean up parent-child links. */
export function untrackExecution(executionId: string): void {
  const entry = registry.get(executionId);
  if (entry?.parentExecutionId) {
    const siblings = children.get(entry.parentExecutionId);
    if (siblings) {
      siblings.delete(executionId);
      if (siblings.size === 0) {
        children.delete(entry.parentExecutionId);
      }
    }
  }

  // Also clean up any children index entry for this execution
  children.delete(executionId);
  registry.delete(executionId);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Get the stream ID for an active execution (undefined if not running). */
export function getStreamIdForExecution(
  executionId: string,
): StreamTabId | undefined {
  return registry.get(executionId)?.streamId;
}

/** Reverse lookup: find the execution ID for a given stream (undefined if none). */
export function getExecutionIdForStream(
  streamId: StreamTabId,
): string | undefined {
  for (const [execId, entry] of registry) {
    if (entry.streamId === streamId) return execId;
  }
  return undefined;
}

/** Get the parent execution ID (undefined if top-level). */
export function getParentExecutionId(
  executionId: string,
): string | undefined {
  return registry.get(executionId)?.parentExecutionId;
}

/** Get direct child execution IDs for a parent. */
export function getChildExecutionIds(
  parentExecutionId: string,
): ReadonlySet<string> {
  return children.get(parentExecutionId) ?? new Set();
}

/** Check if an execution has any active children. */
export function hasActiveChildren(executionId: string): boolean {
  const childSet = children.get(executionId);
  return childSet !== undefined && childSet.size > 0;
}

/**
 * Collect all descendant execution IDs (children, grandchildren, etc.)
 * using breadth-first traversal.
 */
export function getDescendantExecutionIds(
  rootExecutionId: string,
): string[] {
  const descendants: string[] = [];
  const queue = [rootExecutionId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const childSet = children.get(current);
    if (childSet) {
      for (const childId of childSet) {
        descendants.push(childId);
        queue.push(childId);
      }
    }
  }

  return descendants;
}

// ---------------------------------------------------------------------------
// Cascading Interrupt
// ---------------------------------------------------------------------------

/**
 * Interrupt an execution and all its descendants.
 *
 * Walks the execution tree breadth-first, calling interrupt() on each
 * registered interruptible via the ToolUseAgentRegistry.
 *
 * @returns The set of stream IDs that were interrupted
 */
export function interruptWithDescendants(
  executionId: string,
): Set<StreamTabId> {
  const interruptedStreams = new Set<StreamTabId>();

  // Interrupt the root
  const rootEntry = registry.get(executionId);
  if (rootEntry) {
    const interruptible = getInterruptible(rootEntry.streamId);
    if (interruptible) {
      interruptible.interrupt();
      interruptedStreams.add(rootEntry.streamId);
    }
  }

  // Interrupt all descendants
  const descendants = getDescendantExecutionIds(executionId);
  for (const descendantId of descendants) {
    const entry = registry.get(descendantId);
    if (entry) {
      const interruptible = getInterruptible(entry.streamId);
      if (interruptible) {
        interruptible.interrupt();
        interruptedStreams.add(entry.streamId);
      }
    }
  }

  return interruptedStreams;
}
