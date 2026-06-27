import type { ExecutionId, StreamTabId } from '@shared/schemas/identifiers';
import type { Goal } from '@shared/schemas/goal';
import { GoalStore } from '@tools/goal';

export function getRuntimeGoalForStream(streamId: StreamTabId): Goal | null {
  return GoalStore.getForStream(streamId);
}

export function listRuntimeGoals(): Goal[] {
  return GoalStore.list();
}

export function forgetRuntimeGoal(streamId: StreamTabId): Promise<void> {
  return GoalStore.forget(streamId);
}

export function forgetRuntimeGoalsByExecutionIds(
  executionIds: readonly ExecutionId[],
): Promise<void> {
  return GoalStore.forgetByExecutionIds(executionIds);
}
