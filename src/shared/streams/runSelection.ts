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
 * Get the explicit run ID from a workflow state, if any.
 * Returns the selected run ID, falling back to active run ID.
 */
function getExplicitRunId(streamState: StreamState): string | null {
  if (!isWorkflowState(streamState)) return null;
  return streamState.ui.selectedRunId ?? streamState.activeRunId ?? null;
}

/**
 * Get the effective run ID for a stream.
 *
 * In 'strict' mode, returns only explicitly selected/active run IDs (or null).
 * In 'fallback' mode, falls back to the latest root group when no explicit selection exists.
 */
export function getEffectiveRunId(
  streamState: StreamState,
  options: { mode: RunSelectionMode },
): string | null {
  const explicit = getExplicitRunId(streamState);

  if (options.mode === 'strict') {
    return explicit;
  }

  return explicit ?? getLatestRootRunId(streamState.taskGroups);
}
