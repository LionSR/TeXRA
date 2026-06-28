import { describe, expect, it } from 'vitest';

import { SettingsGoalController } from '@controllers/settingsView/SettingsGoalController';
import type { GoalSettingsItem } from '@shared/schemas/settingsViewMessages';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc/settingsViewCommands';

const GOAL_ITEM: GoalSettingsItem = {
  goalId: 'goal-1',
  streamId: 'stream-1',
  objective: 'Finish the autonomous proof audit.',
  status: 'active',
  createdAt: '2026-06-20T00:00:00.000Z',
};

describe('SettingsGoalController', () => {
  it('builds the settings goal-list message from projected goal items', () => {
    const controller = new SettingsGoalController({
      listGoalItems: () => [GOAL_ITEM],
    });

    expect(controller.getGoalListMessage()).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
      items: [GOAL_ITEM],
    });
  });

  it('reads the goal source every time a list message is requested', () => {
    const goals: GoalSettingsItem[] = [];
    const controller = new SettingsGoalController({
      listGoalItems: () => goals,
    });

    expect(controller.getGoalListMessage().items).toEqual([]);
    goals.push(GOAL_ITEM);
    expect(controller.getGoalListMessage().items).toEqual([GOAL_ITEM]);
  });
});
