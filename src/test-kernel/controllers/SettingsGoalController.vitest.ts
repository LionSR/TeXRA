import { describe, expect, it } from 'vitest';

import { SettingsGoalController } from '@controllers/settingsView/SettingsGoalController';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { Goal } from '@shared/schemas/settingsViewMessages';

const GOAL: Goal = {
  goalId: 'goal-1',
  streamId: 'stream-1',
  objective: 'Finish the autonomous proof audit.',
  status: 'active',
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:01:00.000Z',
};

describe('SettingsGoalController', () => {
  it('builds the settings goal-list message from the injected goal source', () => {
    const controller = new SettingsGoalController({
      listGoals: () => [GOAL],
    });

    expect(controller.getGoalListMessage()).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
      items: [GOAL],
    });
  });

  it('reads the goal source every time a list message is requested', () => {
    const goals: Goal[] = [];
    const controller = new SettingsGoalController({
      listGoals: () => goals,
    });

    expect(controller.getGoalListMessage().items).toEqual([]);
    goals.push(GOAL);
    expect(controller.getGoalListMessage().items).toEqual([GOAL]);
  });
});
