import { describe, expect, it } from 'vitest';

import { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import { SettingsProfileHost } from '@controllers/settingsView/SettingsProfileHost';
import { SettingsViewHost } from '@controllers/settingsView/SettingsViewHost';
import { buildBasicModelOptionsData } from '@model/modelOptionsBasic';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ModelOptionData } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
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

function createProfileHost(options: {
  readonly messages: unknown[];
  readonly globalState?: StateStore;
  readonly secretValues?: Map<string, string>;
  readonly refreshAfterKeyChange?: () => Promise<void>;
  readonly setUseIncludedModelAccess?: (enabled: boolean) => Promise<void>;
  readonly setProviderStreaming?: (
    provider: string,
    enabled: boolean,
  ) => Promise<void>;
  readonly setProviderEndpoint?: (
    provider: string,
    endpoint: string,
  ) => Promise<void>;
  readonly setGlobalStreaming?: (enabled: boolean) => Promise<void>;
}) {
  const modelSelection = createModelSelectionController();
  const config = new Map<string, unknown>();
  const globalState = options.globalState ?? createStateStore();
  const secretValues = options.secretValues ?? new Map<string, string>();
  return new SettingsProfileHost({
    state: {
      workspaceState: createStateStore(),
      globalState,
    },
    memoryPrompt: {
      confirm: async () => true,
      warning: async () => undefined,
    },
    respond: (message) => {
      options.messages.push(message);
    },
    controllers: {
      modelSelection: modelSelection.controller,
    },
    profile: {
      globalState,
      providerIds: ['openai'],
      providerVscodeSettings: {},
      providerDisplayNames: { openai: 'OpenAI' },
      providerKeyUrls: { openai: 'https://platform.openai.com/api-keys' },
      loadProviderKeyStatuses: async () => ({ openai: 'set' }),
      getProviderDisplayName: (_provider, defaultName) => defaultName,
      getProviderKeyUrl: (_provider, defaultUrl) => defaultUrl,
      getProviderStreaming: () => true,
      getProviderEndpoint: () => '',
      supportsCustomEndpoint: () => true,
      getConfig: (key, defaultValue) =>
        (config.has(key) ? config.get(key) : defaultValue) as never,
      updateConfig: async (key, value) => {
        config.set(key, value);
      },
      setUseIncludedModelAccess:
        options.setUseIncludedModelAccess ?? (async () => undefined),
      invalidateModelOptionsCache: () => undefined,
    },
    profileKey: {
      prompt: {
        input: async () => 'prompted-key',
        info: async () => undefined,
        confirm: async () => true,
      },
      externalOpener: {
        openExternal: async () => undefined,
      },
      getProviderDisplayName: () => 'OpenAI',
      getProviderKeyUrl: () => 'https://platform.openai.com/api-keys',
      getApiKeySecretName: (provider) => `${provider}-secret`,
      setSecret: async (key, value) => {
        secretValues.set(key, value);
      },
      deleteSecret: async (key) => {
        secretValues.delete(key);
      },
      refreshAfterKeyChange:
        options.refreshAfterKeyChange ?? (async () => undefined),
    },
    providerConfig: {
      setProviderStreaming:
        options.setProviderStreaming ?? (async () => undefined),
      setProviderEndpoint:
        options.setProviderEndpoint ?? (async () => undefined),
      setGlobalStreaming: options.setGlobalStreaming ?? (async () => undefined),
    },
  });
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

  it('posts profile data through shared host wiring', async () => {
    const messages: unknown[] = [];
    const host = createProfileHost({ messages });

    await host.sendProfileData();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      providerKeyStatuses: [
        expect.objectContaining({
          provider: 'openai',
          displayName: 'OpenAI',
          status: 'set',
        }),
      ],
    });
  });

  it('updates provider config ports and reposts profile data', async () => {
    const messages: unknown[] = [];
    const calls: unknown[] = [];
    const host = createProfileHost({
      messages,
      setProviderStreaming: async (provider, enabled) => {
        calls.push(['streaming', provider, enabled]);
      },
      setProviderEndpoint: async (provider, endpoint) => {
        calls.push(['endpoint', provider, endpoint]);
      },
      setGlobalStreaming: async (enabled) => {
        calls.push(['global', enabled]);
      },
    });

    await host.setProviderStreaming('openai', false);
    await host.setProviderEndpoint('openai', 'https://example.test');
    await host.setGlobalStreaming(true);

    expect(calls).toEqual([
      ['streaming', 'openai', false],
      ['endpoint', 'openai', 'https://example.test'],
      ['global', true],
    ]);
    expect(
      messages.filter(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      ),
    ).toHaveLength(3);
  });

  it('delegates provider-key writes and removals through the shared host', async () => {
    const messages: unknown[] = [];
    const secretValues = new Map<string, string>();
    let refreshes = 0;
    const host = createProfileHost({
      messages,
      secretValues,
      refreshAfterKeyChange: async () => {
        refreshes += 1;
      },
    });

    await host.setProviderKey('openai', '  sk-test  ');
    await host.removeProviderKey('openai');

    expect(secretValues.has('openai-secret')).toBe(false);
    expect(refreshes).toBe(2);
  });

  it('sets API access mode, disables OpenRouter for included access, and posts profile plus model selection', async () => {
    const messages: unknown[] = [];
    const globalState = createStateStore();
    await globalState.update(GlobalStateKey.USE_OPENROUTER, true);
    let includedAccess: boolean | undefined;
    const host = createProfileHost({
      messages,
      globalState,
      setUseIncludedModelAccess: async (enabled) => {
        includedAccess = enabled;
      },
    });

    const update = await host.setApiAccessMode('included');

    expect(update).toEqual({ mode: 'included', openRouterDisabled: true });
    expect(includedAccess).toBe(true);
    expect(globalState.get(GlobalStateKey.USE_OPENROUTER, true)).toBe(false);
    expect(
      messages.map((message) => (message as { command: string }).command),
    ).toEqual([
      SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
      SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
    ]);
  });
});
