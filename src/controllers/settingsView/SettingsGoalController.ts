import type {
  Goal,
  UpdateGoalListMessage,
} from '@shared/schemas/settingsViewMessages';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

export interface SettingsGoalControllerDeps {
  listGoals(): readonly Goal[];
}

export class SettingsGoalController {
  constructor(private readonly deps: SettingsGoalControllerDeps) {}

  getGoalListMessage(): UpdateGoalListMessage {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
      items: [...this.deps.listGoals()],
    };
  }
}
