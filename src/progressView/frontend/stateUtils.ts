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
  const streams = [...state.streams];
  const sorted = sortStreams(streams, state.streamSort);
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
): Array<{ id: string; name: string; startTime?: number | string }> {
  return groups
    .filter((group) => !group.parentGroupId)
    .map((group) => ({
      id: group.id,
      name: group.name,
      startTime: group.startTime,
    }));
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
