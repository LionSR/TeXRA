// Local imports - shared schemas
import { isWorkflowState, type StreamState } from '@shared/schemas';

export type RunResolutionMode = 'strict' | 'fallback';

interface ResolveRunIdOptions {
  mode: RunResolutionMode;
}

export function resolveRunId(
  streamState: StreamState,
  options: ResolveRunIdOptions,
): string | null {
  if (isWorkflowState(streamState)) {
    const explicit =
      streamState.selectedRunId ?? streamState.activeRunId ?? null;
    if (explicit || options.mode === 'strict') {
      return explicit;
    }
  }

  if (options.mode === 'strict') {
    return null;
  }

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
