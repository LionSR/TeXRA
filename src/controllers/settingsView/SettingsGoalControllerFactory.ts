import { listRuntimeGoalSettingsItems } from '@agent/runtime/goalCommands';
import { SettingsGoalController } from './SettingsGoalController';

export function createSettingsGoalController(): SettingsGoalController {
  return new SettingsGoalController({
    listGoalItems: listRuntimeGoalSettingsItems,
  });
}
