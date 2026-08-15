/**
 * Model selection controller-layer factory + outbound message builder.
 *
 * Both hosts hand the controller the same global-state store and differ only
 * in the optional extras, so the factory captures that. The outbound message
 * is also shared.
 */
import {
  SettingsModelSelectionController,
  type SettingsModelSelectionControllerDeps,
} from '@controllers/settingsView/SettingsModelSelectionController';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { UpdateModelSelectionMessage } from '@shared/schemas/settingsViewMessages';

import type { SettingsStatePorts } from '@shared/settingsView/types';

export type ModelSelectionExtras = Omit<
  SettingsModelSelectionControllerDeps,
  'globalState'
>;

export function createModelSelectionController(
  ports: SettingsStatePorts,
  extras: ModelSelectionExtras = {},
): SettingsModelSelectionController {
  return new SettingsModelSelectionController({
    ...extras,
    globalState: ports.globalState,
  });
}

export async function buildModelSelectionMessage(
  controller: SettingsModelSelectionController,
): Promise<UpdateModelSelectionMessage> {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
    ...(await controller.buildSelectionData()),
  };
}
