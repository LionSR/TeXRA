// Local imports - shared schemas
import {
  isWorkflowState,
  type StreamState,
  type TaskGroup,
} from '@shared/schemas';

export type RunSelectionMode = 'strict' | 'fallback';

function getLatestRootRunId(taskGroups: TaskGroup[]): string | null {
  let latestId: string | null = null;
  let latestTime = -1;

  for (const group of taskGroups) {
    if (!group.parentGroupId && group.startTime > latestTime) {
      latestId = group.id;
      latestTime = group.startTime;
    }
  }

  return latestId;
}

/**
 * Resolve run ID for a stream, optionally falling back to latest root group.
 */
export function resolveRunId(
  streamState: StreamState,
  options: { mode: RunSelectionMode },
): string | null {
  if (isWorkflowState(streamState)) {
    const explicit =
      streamState.selectedRunId ?? streamState.activeRunId ?? null;
    if (explicit || options.mode === 'strict') {
      return explicit;
    }
  } else if (options.mode === 'strict') {
    return null;
  }

  return getLatestRootRunId(streamState.taskGroups);
}
