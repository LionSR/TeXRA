import { afterEach, describe, expect, it, vi } from 'vitest';

const goalStoreMock = vi.hoisted(() => ({
  getForStream: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
}));

vi.mock('@tools/goal', () => ({
  GoalStore: goalStoreMock,
}));

import {
  getRuntimeGoalControlState,
  getRuntimeGoalSessionStatus,
  listRuntimeGoalSettingsItems,
  startRuntimeGoal,
} from '@agent/runtime/goalCommands';
import type { Goal } from '@shared/schemas/goal';
import type { StreamTabId } from '@shared/schemas/identifiers';

const STREAM_ID = 'root@deepseekT#abcdef123456' as StreamTabId;
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

  it('projects the current goal for CLI session status', () => {
    goalStoreMock.getForStream.mockReturnValue(GOAL);

    expect(getRuntimeGoalSessionStatus(STREAM_ID)).toEqual({
      status: 'active',
      objective: 'finish the proof',
    });
    expect(goalStoreMock.getForStream).toHaveBeenCalledWith(STREAM_ID);

    goalStoreMock.getForStream.mockReturnValue(null);
    expect(getRuntimeGoalSessionStatus(STREAM_ID)).toBeNull();
  });

  it('starts a goal and returns only the CLI session-status projection', async () => {
    goalStoreMock.start.mockResolvedValue({
      ...GOAL,
      objective: 'trimmed proof objective',
    });

    await expect(
      startRuntimeGoal({
        streamId: STREAM_ID,
        objective: '  trimmed proof objective  ',
      }),
    ).resolves.toEqual({
      status: 'active',
      objective: 'trimmed proof objective',
    });
    expect(goalStoreMock.start).toHaveBeenCalledWith(
      STREAM_ID,
      '  trimmed proof objective  ',
    );
  });

  it('projects goal state for host controls', () => {
    goalStoreMock.getForStream.mockReturnValue(GOAL);

    expect(getRuntimeGoalControlState(STREAM_ID)).toEqual({
      active: true,
      status: 'active',
      objective: 'finish the proof',
    });
  });

  it('projects paused and absent goal state for host controls', () => {
    goalStoreMock.getForStream.mockReturnValue({
      ...GOAL,
      status: 'paused',
    });

    expect(getRuntimeGoalControlState(STREAM_ID)).toEqual({
      active: true,
      status: 'paused',
      objective: 'finish the proof',
    });

    goalStoreMock.getForStream.mockReturnValue(null);
    expect(getRuntimeGoalControlState(STREAM_ID)).toEqual({ active: false });
  });

  it('projects settings goal rows without leaking storage-only fields', () => {
    goalStoreMock.list.mockReturnValue([GOAL]);

    expect(listRuntimeGoalSettingsItems()).toEqual([
      {
        goalId: 'goal_abcdef123456',
        streamId: STREAM_ID,
        objective: 'finish the proof',
        status: 'active',
        createdAt: '2026-06-27T00:00:00.000Z',
      },
    ]);
  });
});
