import { describe, expect, it } from 'vitest';

import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import { SettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import { buildBasicModelOptionsData } from '@model/modelOptionsBasic';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ModelOptionData } from '@shared/schemas';
import type { StateStore } from '@platform/interfaces';

function createStateStore(): StateStore {
  const values = new Map<string, unknown>();
  return {
    get: (key, defaultValue) =>
      (values.has(key) ? values.get(key) : defaultValue) as never,
    update: async (key, value) => {
      values.set(key, value);
    },
  };
}

function createMemoryController() {
  let enabled = true;
  return {
    controller: new SettingsMemoryController({
      prompt: {
        confirm: async () => true,
        warning: async () => undefined,
      },
      loadMemoryItems: async () => [],
      loadMemoryPreview: async (storagePath) => ({
        storagePath,
        lineCount: 1,
        preview: 'remember',
      }),
      isMemoryEnabled: () => enabled,
      setMemoryEnabled: async (next) => {
        enabled = next;
      },
      memoryStoragePath: (storagePath) => `mem/${storagePath}`,
      storage: {
        delete: async () => undefined,
        read: async () => '',
        write: async () => undefined,
      },
      maxPinnedMemories: 3,
      parseMemoryFile: (raw) => ({ meta: null, content: raw }),
      buildMemoryFile: (content) => content,
      setPinnedMeta: (meta, pinned) => ({
        modifiedBy: meta?.modifiedBy ?? 'codex',
        modifiedAt: meta?.modifiedAt ?? '2026-07-07T00:00:00.000Z',
        pinned,
      }),
      countPinnedMemories: async () => 0,
    }),
    isEnabled: () => enabled,
  };
}

function createModelSelectionController() {
  const state = {
    enabledModels: ['gpt55', 'sonnet46T'],
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
    const memory = createMemoryController();
    const modelSelection = createModelSelectionController();
    const messages: unknown[] = [];
    let modelRefreshes = 0;
    const host = new SettingsViewHost({
      state: {
        workspaceState: createStateStore(),
        globalState: createStateStore(),
      },
      memoryPrompt: {
        confirm: async () => true,
        warning: async () => undefined,
      },
      respond: (message) => {
        messages.push(message);
      },
      beforeModelSelectionMessage: () => {
        modelRefreshes += 1;
      },
      controllers: {
        memory: memory.controller,
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
    expect(memory.isEnabled()).toBe(false);

    expect(messages.at(2)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      helperModel: 'gpt55',
      preferShortModelNames: false,
    });
    expect(messages.at(3)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      helperModel: 'sonnet46T',
    });
    expect(modelSelection.state.enabledModels).toEqual(['sonnet46T']);
    expect(modelRefreshes).toBe(2);
  });
});
