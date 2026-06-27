import { afterEach, describe, expect, it, vi } from 'vitest';

const goalStoreMock = vi.hoisted(() => ({
  getForStream: vi.fn(),
  list: vi.fn(),
  forget: vi.fn(),
  forgetByExecutionIds: vi.fn(),
}));

vi.mock('@tools/goal', () => ({
  GoalStore: goalStoreMock,
}));

import {
  forgetRuntimeGoal,
  forgetRuntimeGoalsByExecutionIds,
  getRuntimeGoalForStream,
  listRuntimeGoals,
} from '@agent/runtime/goalCommands';
import type { Goal } from '@shared/schemas/goal';
import type { ExecutionId, StreamTabId } from '@shared/schemas/identifiers';

const STREAM_ID = 'root@deepseekT#abcdef123456' as StreamTabId;
const EXECUTION_ID = 'abcdef123456' as ExecutionId;
const GOAL: Goal = {
  goalId: 'goal_abcdef123456',
  streamId: STREAM_ID,
  objective: 'finish the proof',
  status: 'active',
  createdAt: '2026-06-27T00:00:00.000Z',
  updatedAt: '2026-06-27T00:00:00.000Z',
};

describe('runtime goal commands', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reads the current goal for a stream', () => {
    goalStoreMock.getForStream.mockReturnValue(GOAL);

    expect(getRuntimeGoalForStream(STREAM_ID)).toEqual(GOAL);
    expect(goalStoreMock.getForStream).toHaveBeenCalledWith(STREAM_ID);
  });

  it('lists goals through the runtime boundary', () => {
    goalStoreMock.list.mockReturnValue([GOAL]);

    expect(listRuntimeGoals()).toEqual([GOAL]);
  });

  it('forgets goals through runtime commands', async () => {
    goalStoreMock.forget.mockResolvedValue(undefined);
    goalStoreMock.forgetByExecutionIds.mockResolvedValue(undefined);

    await forgetRuntimeGoal(STREAM_ID);
    await forgetRuntimeGoalsByExecutionIds([EXECUTION_ID]);

    expect(goalStoreMock.forget).toHaveBeenCalledWith(STREAM_ID);
    expect(goalStoreMock.forgetByExecutionIds).toHaveBeenCalledWith([
      EXECUTION_ID,
    ]);
  });
});
