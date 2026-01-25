// Local imports
import type { FollowupStreamData } from './components/FollowupSection';
import {
  getEffectiveRunId,
  type ProgressState,
  type StreamSort,
  type StreamState,
} from './store';

// Local imports - shared schemas
import type { StreamTabInfo, TaskGroup } from '@shared/schemas';

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

/**
 * Sort streams by the specified criteria.
 */
export function sortStreams(
  streams: StreamTabInfo[],
  sort: StreamSort,
): StreamTabInfo[] {
  return [...streams].sort((a, b) => {
    switch (sort) {
      case 'agent':
        return (a.agent ?? '').localeCompare(b.agent ?? '');
      case 'inputFile':
        return (a.inputFile ?? '').localeCompare(b.inputFile ?? '');
      case 'time':
      default: {
        const aTime = a.lastTimestamp ?? a.creationTimestamp ?? 0;
        const bTime = b.lastTimestamp ?? b.creationTimestamp ?? 0;
        return bTime - aTime;
      }
    }
  });
}

/**
 * Extract run groups from task groups for the run selector.
 */
export function getRunGroups(
  groups: TaskGroup[],
): { id: string; name: string; startTime?: number | string }[] {
  return groups
    .filter((group) => !group.parentGroupId)
    .map((group) => ({
      id: group.id,
      name: group.name,
      startTime: group.startTime,
    }));
}

/**
 * Resolve the best run ID when none is explicitly selected.
 * Used to find the active run from available candidates.
 *
 * Resolution priority:
 * 1. If a selectedRunId is set, use it
 * 2. If an activeRunId is set, use it
 * 3. If there's exactly one root task group, use its ID
 * 4. If there are multiple root task groups, use the one with the latest startTime
 * 5. Fall back to the latest run from runInstructions, runUsage, or runFiles maps
 * 6. Return null if no candidates found
 */
export function resolveActiveRunId(streamState: StreamState): string | null {
  // 1. Check explicit selections first
  if (streamState.selectedRunId) return streamState.selectedRunId;
  if (streamState.activeRunId) return streamState.activeRunId;

  // 2. Collect candidates from root task groups
  const rootGroups = streamState.taskGroups.filter(
    (group) => !group.parentGroupId,
  );

  if (rootGroups.length === 1) {
    return rootGroups[0]!.id;
  }

  if (rootGroups.length > 1) {
    // Find the group with the latest start time
    const getTime = (g: TaskGroup): number =>
      typeof g.startTime === 'number' ? g.startTime : 0;
    const sorted = [...rootGroups].sort((a, b) => getTime(b) - getTime(a));
    return sorted[0]?.id ?? null;
  }

  // 3. Fall back to run-scoped maps
  const candidates = new Set<string>();

  for (const runId of Object.keys(streamState.runInstructions ?? {})) {
    if (runId && runId !== 'default') candidates.add(runId);
  }
  for (const runId of Object.keys(streamState.runUsage ?? {})) {
    if (runId && runId !== 'default') candidates.add(runId);
  }
  for (const runId of Object.keys(streamState.runFiles ?? {})) {
    if (runId && runId !== 'default') candidates.add(runId);
  }

  if (candidates.size === 1) {
    return [...candidates][0]!;
  }

  // Multiple candidates - can't determine best one without timestamps
  // Return the first one as a fallback
  if (candidates.size > 0) {
    return [...candidates][0]!;
  }

  return null;
}

/**
 * Build data for the followup section component.
 */
export function buildFollowupData(
  stream: StreamTabInfo,
  streamState: StreamState | null,
): FollowupStreamData | null {
  if (!stream || !streamState) return null;

  const runId = getEffectiveRunId(streamState);
  const runFiles = runId ? (streamState.runFiles?.[runId] ?? {}) : {};
  const fileCount = Object.values(runFiles).flat().length;

  const instruction = runId ? streamState.runInstructions?.[runId] : null;
  const instructionPreview = instruction?.text
    ? instruction.text.slice(0, 100) +
      (instruction.text.length > 100 ? '...' : '')
    : null;

  return {
    agentCategory: stream.agentCategory,
    status: streamState.status ?? stream.status,
    hasOutputFiles: fileCount > 0,
    agentName: stream.name.split('@')[0] || stream.name,
    instructionPreview,
    fileCount,
  };
}
