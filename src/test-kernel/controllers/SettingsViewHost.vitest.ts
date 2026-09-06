import { describe, expect, it, vi } from 'vitest';

import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import { SettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import { buildBaseModelOption } from '@model/modelOptionsBasic';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { ModelOptionData } from '@shared/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';

function createModelSelectionController(globalState: FakeStateStore) {
  const resolveModelOptions = async (
    models: readonly string[],
  ): Promise<ModelOptionData[]> =>
    models
      .map((model) => {
        const config = getRuntimeModelConfig(model);
        return config
          ? buildBaseModelOption(model, config)
          : { value: model, label: model };
      })
      .map((option) => ({
        ...option,
        availability: 'provider-key',
        availabilityLabel: 'API key set',
        requiresKey: false,
        disabled: false,
      }));

  return new SettingsModelSelectionController({
    globalState,
    resolveModelOptions,
  });
}

describe('SettingsViewHost', () => {
  it('posts model-selection messages through shared host wiring', async () => {
    const globalState = new FakeStateStore({
      [GlobalStateKey.ENABLED_MODELS]: ['gpt55', 'sonnet46T'],
      [GlobalStateKey.HELPER_MODEL]: 'gpt55',
    });
    const modelSelection = createModelSelectionController(globalState);
    const messages: unknown[] = [];
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
      controllers: {
        modelSelection,
      },
    });

    await host.sendModelSelectionData();
    await host.setModelEnabled({ modelName: 'gpt55', enabled: false });

    expect(host).not.toHaveProperty('sendProfileData');
    expect(messages.at(0)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      helperModel: 'gpt55',
      preferShortModelNames: false,
    });
    expect(messages.at(1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      helperModel: DEFAULT_HELPER_MODEL,
    });
    expect(globalState.get(GlobalStateKey.ENABLED_MODELS)).toEqual([
      'sonnet46T',
    ]);
  });
});
