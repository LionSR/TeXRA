import { describe, expect, it, vi } from 'vitest';

import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import { SettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import { buildBasicModelOptionsData } from '@model/modelOptionsBasic';
import type { ModelOptionData } from '@shared/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

function createModelSelectionController() {
  const state = {
    enabledModels: ['gpt55', 'sonnet46T'] as readonly string[],
    helperModel: 'gpt55',
    reasoningLevelOverrides: {},
    preferShortModelNames: false,
  };
  const resolveModelOptions = async (
    models: readonly string[],
  ): Promise<ModelOptionData[]> =>
    buildBasicModelOptionsData(models).map((option) => ({
      ...option,
      availability: 'provider-key',
      availabilityLabel: 'API key set',
      requiresKey: false,
      disabled: false,
    }));

  return {
    controller: new SettingsModelSelectionController({
      state: {
        getEnabledModels: () => state.enabledModels,
        setEnabledModels: async (models) => {
          state.enabledModels = models;
        },
        getHelperModel: () => state.helperModel,
        setHelperModel: async (model) => {
          state.helperModel = model;
        },
        getReasoningLevelOverrides: () => state.reasoningLevelOverrides,
        setReasoningLevelOverrides: async (overrides) => {
          state.reasoningLevelOverrides = overrides;
        },
        getPreferShortModelNames: () => state.preferShortModelNames,
        setPreferShortModelNames: async (enabled) => {
          state.preferShortModelNames = enabled;
        },
      },
      resolveModelOptions,
    }),
    state,
  };
}

describe('SettingsViewHost', () => {
  it('posts memory and model-selection messages through shared host wiring', async () => {
    const modelSelection = createModelSelectionController();
    const globalState = new FakeStateStore();
    const messages: unknown[] = [];
    const beforeModelSelectionMessage = vi.fn();
    const host = new SettingsViewHost({
      state: {
        workspaceState: new FakeStateStore(),
        globalState,
      },
      memoryPrompt: {
        confirm: async () => true,
        warning: async () => undefined,
      },
      respond: (message) => {
        messages.push(message);
      },
      beforeModelSelectionMessage,
      controllers: {
        modelSelection: modelSelection.controller,
      },
    });

    await host.sendMemoryEnabled();
    await host.setMemoryEnabled(false);
    await host.sendModelSelectionData();
    await host.setModelEnabled({ modelName: 'gpt55', enabled: false });

    expect(host).not.toHaveProperty('sendProfileData');
    expect(messages.at(0)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
      enabled: true,
    });
    expect(messages.at(1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED,
      enabled: false,
    });
    expect(globalState.get(GlobalStateKey.MEMORY_ENABLED)).toBe(false);

    expect(messages.at(2)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      helperModel: 'gpt55',
      preferShortModelNames: false,
    });
    expect(messages.at(3)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      helperModel: DEFAULT_HELPER_MODEL,
    });
    expect(modelSelection.state.enabledModels).toEqual(['sonnet46T']);
    expect(beforeModelSelectionMessage).toHaveBeenCalledTimes(2);
  });
});
