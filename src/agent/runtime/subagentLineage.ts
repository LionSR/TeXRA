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

import { bus } from '@eventBus/ProgressEventBus';
import { getInterruptible } from '@agent/toolUse/ToolUseAgentRegistry';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  STREAM_STATUS,
  type ActiveSubagentInfo,
  type StreamTabId,
} from '@shared/schemas';

interface SubagentEntry {
  parentStreamId: StreamTabId;
  childStreamId: StreamTabId;
  childAgentName: string;
  startedAt: number;
}

const activeSubagents = new Map<string, SubagentEntry>();

/** Emit the current active children list for a parent to the progress UI. */
function emitActiveSubagentsUpdate(parentStreamId: StreamTabId): void {
  const children = getActiveChildrenSummary(parentStreamId);
  bus.emit('updateActiveSubagents', { parentStreamId, children });
}

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
    startedAt: Date.now(),
  });
  emitActiveSubagentsUpdate(parentStreamId);
  bus.emit('setParentStream', { childStreamId, parentStreamId });

  // .catch suppresses the derived promise's unhandled rejection —
  // the original promise's rejection is handled by the caller.
  promise
    .finally(() => {
      activeSubagents.delete(executionId);
      emitActiveSubagentsUpdate(parentStreamId);
    })
    .catch(() => {});
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
  return [...activeSubagents.values()].some(
    (e) => e.parentStreamId === parentStreamId,
  );
}

/** Get a specific active subagent entry by execution ID. */
export function getActiveSubagent(
  executionId: string,
): SubagentEntry | undefined {
  return activeSubagents.get(executionId);
}

/** Get summary of active children for a parent stream (for UI display and events). */
export function getActiveChildrenSummary(
  parentStreamId: StreamTabId,
): ActiveSubagentInfo[] {
  return [...activeSubagents.entries()]
    .filter(([, e]) => e.parentStreamId === parentStreamId)
    .map(([execId, e]) => ({
      executionId: execId,
      agentName: e.childAgentName,
    }));
}

/** Get the start timestamp (ms) for an active subagent. */
export function getSubagentStartedAt(executionId: string): number | undefined {
  return activeSubagents.get(executionId)?.startedAt;
}

/** Check if a stream is itself a subagent (has a parent). */
export function isSubagent(streamId: StreamTabId): boolean {
  return [...activeSubagents.values()].some(
    (e) => e.childStreamId === streamId,
  );
}

/**
 * Interrupt all active subagents of a parent stream.
 * Called before interrupting the parent so subagents stop
 * promptly instead of running to completion.
 */
export function interruptActiveChildren(parentStreamId: StreamTabId): void {
  for (const child of getActiveChildren(parentStreamId)) {
    getInterruptible(child.childStreamId)?.interrupt();
    StreamStatusService.set(child.childStreamId, STREAM_STATUS.STOPPED);
  }
}
