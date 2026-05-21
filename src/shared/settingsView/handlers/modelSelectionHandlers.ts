/**
 * Model selection shared handlers.
 *
 * The controller already encapsulates the read/write logic — this module
 * wraps it with the outbound message shape and the small caching dance
 * (`invalidateModelOptionsCache`) that both hosts need after mutations.
 */
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import type { UpdateModelSelectionMessage } from '@shared/schemas/settingsViewMessages';
import type { ReasoningLevel } from '@shared/schemas/settingsViewMessages';
import type { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';

export function buildModelSelectionMessage(
  controller: SettingsModelSelectionController,
): UpdateModelSelectionMessage {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
    ...controller.buildSelectionData(),
  };
}

export async function setModelEnabled(
  controller: SettingsModelSelectionController,
  input: { modelName: string; enabled: boolean },
): Promise<void> {
  await controller.setModelEnabled(input);
  invalidateModelOptionsCache();
}

export async function setReasoningLevel(
  controller: SettingsModelSelectionController,
  input: { modelName: string; level: ReasoningLevel | null },
): Promise<void> {
  await controller.setReasoningLevel(input);
}

export async function setHelperModel(
  controller: SettingsModelSelectionController,
  modelName: string,
): Promise<void> {
  await controller.setHelperModel(modelName);
}

export async function setPreferShortModelNames(
  controller: SettingsModelSelectionController,
  enabled: boolean,
): Promise<void> {
  await controller.setPreferShortModelNames(enabled);
}
