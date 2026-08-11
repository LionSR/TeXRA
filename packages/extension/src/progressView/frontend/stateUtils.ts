// Shared imports
import { create } from 'mutative';
import {
  isToolUseState,
  isWorkflowState,
  sumUsageStats,
  type OutputFileInfo,
  type StreamTabId,
  type TokenUsageStats,
  type ToolUseStreamState,
  type WorkflowStreamState,
} from '@shared/schemas';

// Local imports
import { appState, setStreamStateForId } from './progressState';
import type { PermissionState } from './permissionState';

/**
 * Update a per-round record. Handles full reset and merge semantics.
 * One run per tab — no longer keyed by runId.
 */
export function updateRounds<T>(
  current: Record<string, T[]>,
  update: { rounds?: Record<string, T[]>; reset?: boolean },
): Record<string, T[]> {
  const { rounds, reset } = update;
  if (reset) {
    return rounds ? { ...rounds } : {};
  }
  if (!rounds) return current;
  return { ...current, ...rounds };
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

export function hasOutputFiles(
  filesByRound: Record<string, OutputFileInfo[]>,
): boolean {
  return Object.values(filesByRound).some((files) => files.length > 0);
}

/**
 * Session-total usage for one stream, summed over its per-run map. Memoized
 * by the map's identity: Mutative's structural sharing keeps `runUsage`
 * reference-stable across unrelated state ticks, so both stream-content
 * components hand the usage panel the same total object instead of re-summing
 * (and re-rendering) on every render.
 */
const runUsageTotals = new WeakMap<
  Record<string, TokenUsageStats>,
  TokenUsageStats
>();
export function totalRunUsage(
  runUsage: Record<string, TokenUsageStats>,
): TokenUsageStats {
  const cached = runUsageTotals.get(runUsage);
  if (cached) return cached;
  const total = sumUsageStats(Object.values(runUsage));
  runUsageTotals.set(runUsage, total);
  return total;
}

// =============================================================================
// Typed State Updaters
// =============================================================================

/**
 * Update tool-use stream state with type narrowing.
 * If the stream is not a tool-use stream, returns previous state unchanged.
 */
export function updateToolUseState(
  stream: StreamTabId,
  updater: (prev: ToolUseStreamState) => ToolUseStreamState,
): void {
  setStreamStateForId(stream, (prev) => {
    if (!isToolUseState(prev)) return prev;
    return updater(prev);
  });
}

/**
 * Update workflow stream state with type narrowing.
 * If the stream is not a workflow stream, returns previous state unchanged.
 */
export function updateWorkflowState(
  stream: StreamTabId,
  updater: (prev: WorkflowStreamState) => WorkflowStreamState,
): void {
  setStreamStateForId(stream, (prev) => {
    if (!isWorkflowState(prev)) return prev;
    return updater(prev);
  });
}
