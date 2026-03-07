// Shared imports
import { create } from 'mutative';
import type { OutputFileInfo, StreamTabId, TaskGroup } from '@shared/schemas';
import {
  isToolUseState,
  isWorkflowState,
  type ToolUseStreamState,
  type WorkflowStreamState,
} from './store';

// Local imports
import type { FrontendEventHandlerContext } from './eventHandlers';
import type { PermissionState } from './components/PermissionCard';

/**
 * Updates a nested Record<runId, Record<round, T[]>> structure.
 * Handles reset semantics: full reset, run-specific reset, or merge.
 */
export function updateNestedRounds<T>(
  current: Record<string, Record<string, T[]>>,
  update: { runId?: string; rounds?: Record<string, T[]>; reset?: boolean },
): Record<string, Record<string, T[]>> {
  const { runId, rounds, reset } = update;

  // Full reset - clear all runs
  if (reset && !runId) return {};

  // No target run - no change
  if (!runId) return current;

  // Reset specific run without new data - remove this run
  if (reset && !rounds) {
    const { [runId]: _, ...rest } = current;
    return rest;
  }

  // No rounds data - no change
  if (!rounds) return current;

  // Merge rounds into the run
  const base = reset ? { ...current } : current;
  const existingRounds = reset ? {} : (base[runId] ?? {});
  return {
    ...base,
    [runId]: { ...existingRounds, ...rounds },
  };
}

/** Run group info for the run selector */
export interface RunGroup {
  id: string;
  name: string;
  startTime: number;
}

/**
 * Extract run groups from task groups for the run selector.
 * Returns root groups (runs) with their metadata.
 * Uses a single pass to avoid extra array allocations from filter().map().
 */
export function getRunGroups(groups: TaskGroup[]): RunGroup[] {
  const result: RunGroup[] = [];
  for (const group of groups) {
    if (!group.parentGroupId) {
      result.push({
        id: group.id,
        name: group.name,
        startTime: group.startTime,
      });
    }
  }
  return result;
}

/**
 * Check if any output files exist in the run files record.
 * Returns true as soon as a non-empty array is found.
 * More efficient than Object.values().flat().length > 0 which allocates arrays.
 */
export function hasOutputFiles(
  runFiles: Record<string, OutputFileInfo[]> | undefined,
): boolean {
  if (!runFiles) return false;
  for (const key in runFiles) {
    if (Object.hasOwn(runFiles, key)) {
      const files = runFiles[key];
      if (files && files.length > 0) return true;
    }
  }
  return false;
}

/**
 * Filter permissions to those relevant to a specific stream.
 * Keeps permissions that have no streamId or match the given streamId.
 */
export function filterPermissionsForStream(
  permissions: PermissionState[],
  streamId: string | undefined,
): PermissionState[] {
  if (!streamId) return [];
  return permissions.filter(
    (permission) =>
      !permission.data.streamId || permission.data.streamId === streamId,
  );
}

/**
 * Remove all permissions associated with a specific stream.
 * Keeps permissions that have no streamId (global) or belong to a different stream.
 */
export function removePermissionsForStream(
  permissions: PermissionState[],
  streamId: string,
): PermissionState[] {
  return permissions.filter(
    (permission) =>
      !permission.data.streamId || permission.data.streamId !== streamId,
  );
}

// =============================================================================
// Typed State Updaters
// =============================================================================

/**
 * Update tool-use stream state with type narrowing.
 * If the stream is not a tool-use stream, returns previous state unchanged.
 */
export function updateToolUseState(
  ctx: FrontendEventHandlerContext,
  stream: StreamTabId,
  updater: (prev: ToolUseStreamState) => ToolUseStreamState,
): void {
  ctx.setStreamState(stream, (prev) => {
    if (!isToolUseState(prev)) return prev;
    return updater(prev);
  });
}

/**
 * Update workflow stream state with type narrowing.
 * If the stream is not a workflow stream, returns previous state unchanged.
 */
export function updateWorkflowState(
  ctx: FrontendEventHandlerContext,
  stream: StreamTabId,
  updater: (prev: WorkflowStreamState) => WorkflowStreamState,
): void {
  ctx.setStreamState(stream, (prev) => {
    if (!isWorkflowState(prev)) return prev;
    return updater(prev);
  });
}

/**
 * Update a stream's parentStreamId in the streamById map.
 * No-op if the stream doesn't exist or the parentStreamId hasn't changed.
 */
export function updateParentStreamId(
  ctx: FrontendEventHandlerContext,
  streamId: string,
  parentStreamId: string | null | undefined,
): void {
  const resolved = parentStreamId ?? undefined;
  ctx.setState((prev) => {
    const target = prev.streamById.get(streamId);
    if (!target || target.parentStreamId === resolved) return prev;
    return create(prev, (draft) => {
      draft.streamById.set(streamId, { ...target, parentStreamId: resolved });
    });
  });
}
