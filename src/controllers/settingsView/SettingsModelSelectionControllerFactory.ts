/**
 * Model selection controller-layer factory + outbound message builder.
 *
 * Both hosts wire the same four global-state pairs into the controller, so
 * the factory captures that. The outbound message is also shared.
 */
import {
  SettingsModelSelectionController,
  type SettingsModelSelectionControllerDeps,
} from '@controllers/settingsView/SettingsModelSelectionController';
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { UpdateModelSelectionMessage } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';

import type { SettingsStatePorts } from '@shared/settingsView/types';

export type ModelSelectionExtras = Omit<
  SettingsModelSelectionControllerDeps,
  'state'
>;

export function createModelSelectionController(
  ports: SettingsStatePorts,
  extras: ModelSelectionExtras = {},
): SettingsModelSelectionController {
  const { globalState } = ports;
  return new SettingsModelSelectionController({
    ...extras,
    state: {
      getEnabledModels: () =>
        globalState.get<readonly string[]>(
          GlobalStateKey.ENABLED_MODELS,
          DEFAULT_MODELS,
        ),
      setEnabledModels: async (models) => {
        await globalState.update(GlobalStateKey.ENABLED_MODELS, models);
      },
      getHelperModel: () =>
        globalState.get<string>(GlobalStateKey.HELPER_MODEL),
      setHelperModel: async (model) => {
        await globalState.update(GlobalStateKey.HELPER_MODEL, model);
      },
      getReasoningLevelOverrides: () =>
        globalState.get<Record<string, string>>(
          GlobalStateKey.REASONING_LEVELS,
          {},
        ),
      setReasoningLevelOverrides: async (overrides) => {
        await globalState.update(GlobalStateKey.REASONING_LEVELS, overrides);
      },
      getPreferShortModelNames: () =>
        globalState.get<boolean>(GlobalStateKey.PREFER_SHORT_MODEL_NAMES),
      setPreferShortModelNames: async (enabled) => {
        await globalState.update(
          GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
          enabled,
        );
      },
    },
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
