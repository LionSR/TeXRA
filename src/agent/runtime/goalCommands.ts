import type { StreamTabId } from '@shared/schemas/identifiers';
import {
  isGoalInFlight,
  type Goal,
  type GoalStatus,
} from '@shared/schemas/goal';
import { GoalStore } from '@tools/goal';

export interface RuntimeGoalControlState {
  readonly active: boolean;
  readonly status?: GoalStatus;
  readonly objective?: string;
}

export interface RuntimeGoalSessionStatus {
  readonly status: GoalStatus;
  readonly objective: string;
}

export interface StartRuntimeGoalRequest {
  readonly streamId: StreamTabId;
  readonly objective: string;
}

export interface RuntimeGoalSettingsItem {
  readonly goalId: string;
  readonly streamId: StreamTabId;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly createdAt: string;
}

function toRuntimeGoalSessionStatus(goal: Goal): RuntimeGoalSessionStatus {
  return { status: goal.status, objective: goal.objective };
}

export function getRuntimeGoalSessionStatus(
  streamId: StreamTabId,
): RuntimeGoalSessionStatus | null {
  const goal = GoalStore.getForStream(streamId);
  return goal ? toRuntimeGoalSessionStatus(goal) : null;
}

export function getRuntimeGoalControlState(
  streamId: StreamTabId,
): RuntimeGoalControlState {
  const goal = GoalStore.getForStream(streamId);
  return {
    active: isGoalInFlight(goal),
    ...(goal?.status ? { status: goal.status } : {}),
    ...(goal?.objective ? { objective: goal.objective } : {}),
  };
}

export async function startRuntimeGoal({
  streamId,
  objective,
}: StartRuntimeGoalRequest): Promise<RuntimeGoalSessionStatus> {
  return toRuntimeGoalSessionStatus(await GoalStore.start(streamId, objective));
}

function toRuntimeGoalSettingsItem(goal: Goal): RuntimeGoalSettingsItem {
  return {
    goalId: goal.goalId,
    streamId: goal.streamId,
    objective: goal.objective,
    status: goal.status,
    createdAt: goal.createdAt,
  };
}

export function listRuntimeGoalSettingsItems(): RuntimeGoalSettingsItem[] {
  return GoalStore.list().map(toRuntimeGoalSettingsItem);
}
