// Local imports
import {
  getEffectiveRunId,
  type ProgressState,
  type StreamSort,
  type StreamState,
} from './store';

// Local imports - shared schemas
import type {
  InstructionUpdate,
  OutputFileInfo,
  StreamTabInfo,
  TaskGroup,
  TokenUsageStats,
} from '@shared/schemas';

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
  const base = reset ? {} : current;
  const existingRounds = base[runId] ?? {};
  return {
    ...base,
    [runId]: { ...existingRounds, ...rounds },
  };
}

/**
 * Get filtered streams based on current filter setting.
 */
export function getFilteredStreams(state: ProgressState): StreamTabInfo[] {
  const sorted = sortStreams(state.streams, state.streamSort);
  if (state.streamFilter === 'all') return sorted;
  return sorted.filter((stream) => stream.agentCategory === state.streamFilter);
}

// Comparator functions for stream sorting - avoid creating functions on each sort call
const streamComparators: Record<
  StreamSort,
  (a: StreamTabInfo, b: StreamTabInfo) => number
> = {
  agent: (a, b) => (a.agent ?? '').localeCompare(b.agent ?? ''),
  inputFile: (a, b) => (a.inputFile ?? '').localeCompare(b.inputFile ?? ''),
  time: (a, b) => {
    const aTime = a.lastTimestamp ?? a.creationTimestamp ?? 0;
    const bTime = b.lastTimestamp ?? b.creationTimestamp ?? 0;
    return bTime - aTime;
  },
};

/**
 * Sort streams by the specified criteria.
 * Returns sorted copy without mutating original.
 */
function sortStreams(
  streams: StreamTabInfo[],
  sort: StreamSort,
): StreamTabInfo[] {
  return [...streams].sort(streamComparators[sort] ?? streamComparators.time);
}

/**
 * Extract run groups from task groups for the run selector.
 * Returns root groups (runs) with their metadata.
 * Uses a single pass to avoid extra array allocations from filter().map().
 */
export function getRunGroups(
  groups: TaskGroup[],
): { id: string; name: string; startTime: number }[] {
  const result: { id: string; name: string; startTime: number }[] = [];
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
    if (Object.prototype.hasOwnProperty.call(runFiles, key)) {
      const files = runFiles[key];
      if (files && files.length > 0) return true;
    }
  }
  return false;
}

/**
 * Resolve the best run ID when none is explicitly selected.
 *
 * Resolution priority:
 * 1. Explicit selection (selectedRunId or activeRunId from backend)
 * 2. Latest root task group by startTime (guaranteed number per TaskGroupSchema)
 *
 * Note: No fallback to run-scoped maps needed - task groups are the source of
 * truth for runs, and the backend provides activeRunId when known.
 */
export function resolveActiveRunId(streamState: StreamState): string | null {
  // Check explicit selections first (from user or backend)
  if (streamState.selectedRunId) return streamState.selectedRunId;
  if (streamState.activeRunId) return streamState.activeRunId;

  // Find latest root task group - use reduce to avoid extra array allocations
  let latestId: string | null = null;
  let latestTime = -1;

  for (const group of streamState.taskGroups) {
    if (!group.parentGroupId && group.startTime > latestTime) {
      latestId = group.id;
      latestTime = group.startTime;
    }
  }

  return latestId;
}
