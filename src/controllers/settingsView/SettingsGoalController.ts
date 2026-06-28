import type {
  GoalSettingsItem,
  UpdateGoalListMessage,
} from '@shared/schemas/settingsViewMessages';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc/settingsViewCommands';

export interface SettingsGoalControllerDeps {
  listGoalItems(): readonly GoalSettingsItem[];
}

export class SettingsGoalController {
  constructor(private readonly deps: SettingsGoalControllerDeps) {}

  getGoalListMessage(): UpdateGoalListMessage {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
      items: [...this.deps.listGoalItems()],
    };
  }
}
