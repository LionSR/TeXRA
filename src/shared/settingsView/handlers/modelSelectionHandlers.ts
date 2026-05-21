/**
 * Model selection shared handlers and controller factory.
 *
 * The controller encapsulates the read/write logic; this module exposes a
 * factory that builds it from a `SettingsStatePorts` and wraps the result
 * in the outbound message shape plus the `invalidateModelOptionsCache` dance
 * both hosts perform after mutations.
 */
import {
  SettingsModelSelectionController,
  type SettingsModelSelectionControllerDeps,
} from '@controllers/settingsView/SettingsModelSelectionController';
import { GlobalStateKey } from '@common/state/stateKeys';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import type {
  ReasoningLevel,
  UpdateModelSelectionMessage,
} from '@shared/schemas/settingsViewMessages';

import type { SettingsStatePorts } from './types';

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
        globalState.get<string[]>(
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
