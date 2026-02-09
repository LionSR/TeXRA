/**
 * Parent-child lineage tracking for active subagents.
 *
 * Tracks which subagents are currently running under which orchestrator.
 * Used for: result routing (Mode C), queue lifetime management,
 * cascading cancellation, and nesting enforcement.
 *
 * Entries auto-remove when the subagent's promise settles.
 * Does NOT store promises or results — Mode B keeps its own promise
 * reference, Mode C delivers via .then(). Each concern has one owner.
 */

import type { StreamTabId } from '@shared/schemas';

interface SubagentEntry {
  parentStreamId: StreamTabId;
  childStreamId: StreamTabId;
  childAgentName: string;
}

const activeSubagents = new Map<string, SubagentEntry>();

/**
 * Register a subagent. Entry auto-removes when the promise settles.
 *
 * @param executionId - Execution ID for this subagent (same ID used in runs tool and XML delivery)
 * @param parentStreamId - Orchestrator's stream ID
 * @param childStreamId - Subagent's stream ID
 * @param childAgentName - Name of the subagent being run
 * @param promise - The subagent's execution promise (for auto-cleanup)
 */
export function registerSubagent(
  executionId: string,
  parentStreamId: StreamTabId,
  childStreamId: StreamTabId,
  childAgentName: string,
  promise: Promise<unknown>,
): void {
  activeSubagents.set(executionId, {
    parentStreamId,
    childStreamId,
    childAgentName,
  });
  // .catch suppresses the derived promise's unhandled rejection —
  // the original promise's rejection is handled by the caller.
  promise.finally(() => activeSubagents.delete(executionId)).catch(() => {});
}

/** Get all active children for a given orchestrator stream. */
export function getActiveChildren(
  parentStreamId: StreamTabId,
): SubagentEntry[] {
  return [...activeSubagents.values()].filter(
    (e) => e.parentStreamId === parentStreamId,
  );
}

/** Check if an orchestrator has any active subagents. */
export function hasActiveChildren(parentStreamId: StreamTabId): boolean {
  return getActiveChildren(parentStreamId).length > 0;
}

/** Check if a stream is itself a subagent (has a parent). */
export function isSubagent(streamId: StreamTabId): boolean {
  return [...activeSubagents.values()].some(
    (e) => e.childStreamId === streamId,
  );
}
