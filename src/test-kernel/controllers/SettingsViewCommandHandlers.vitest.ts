import { describe, expect, it, vi } from 'vitest';

import { createSettingsViewCommandHandlers } from '@controllers/settingsView/SettingsViewCommandHandlers';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

describe('createSettingsViewCommandHandlers', () => {
  it('composes handlers from domain groups', () => {
    const getMemoryData = vi.fn();
    const getGoalList = vi.fn();

    const handlers = createSettingsViewCommandHandlers({
      memory: { getMemoryData },
      goal: { getGoalList },
    });

    handlers[SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA]?.({
      command: SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA,
    });
    handlers[SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST]?.({
      command: SETTINGS_VIEW_COMMANDS.GET_GOAL_LIST,
    });

    expect(getMemoryData).toHaveBeenCalledOnce();
    expect(getGoalList).toHaveBeenCalledOnce();
  });
});
