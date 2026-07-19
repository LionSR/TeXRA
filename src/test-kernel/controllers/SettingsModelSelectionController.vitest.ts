import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS, type ModelConfig } from 'llm-zoo';

import {
  SettingsModelSelectionController,
  type SettingsModelSelectionState,
} from '@controllers/settingsView/SettingsModelSelectionController';
import { MAX_TIER } from '@auth/config';
import { buildBasicModelOptionsData } from '@model/modelOptionsBasic';
import type { ModelOptionData } from '@shared/schemas';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';

const NO_RUNTIME_MODELS = async (): Promise<
  readonly (readonly [string, ModelConfig])[]
> => [];

// Stub the injected availability resolver so the controller stays decoupled
// from the global platform / server-side key service in unit tests.
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

function createState(
  overrides: Partial<{
    enabledModels: string[];
    helperModel: string;
    reasoningLevelOverrides: Record<string, string>;
    preferShortModelNames: boolean;
  }> = {},
): SettingsModelSelectionState {
  const state = {
    enabledModels: overrides.enabledModels,
    helperModel: overrides.helperModel,
    reasoningLevelOverrides: overrides.reasoningLevelOverrides,
    preferShortModelNames: overrides.preferShortModelNames,
  };
  return {
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
  };
}

describe('SettingsModelSelectionController', () => {
  it('uses canonical tier constants for included-access reasoning caps', async () => {
    const controller = new SettingsModelSelectionController({
      state: createState(),
      useIncludedAccess: () => true,
      getUserTier: () => MAX_TIER,
      resolveModelOptions,
      getRuntimeModelEntries: NO_RUNTIME_MODELS,
    });

    const { models } = await controller.buildSelectionData();
    const gpt55 = models.find((model) => model.name === 'gpt55');

    expect(gpt55).toMatchObject({
      supportsReasoningLevel: true,
      includedAccessReasoningCap: 'high',
    });
  });

  it('does not expose a reasoning selector for Kimi K3 fixed max effort', async () => {
    const controller = new SettingsModelSelectionController({
      state: createState({ reasoningLevelOverrides: { kimi3: 'low' } }),
      resolveModelOptions,
      getRuntimeModelEntries: NO_RUNTIME_MODELS,
    });

    const { models } = await controller.buildSelectionData();
    const kimi3 = models.find((model) => model.name === 'kimi3');

    expect(MODEL_CONFIGS.kimi3.capabilities).toMatchObject({
      supportsReasoningEffort: true,
      reasoningEffort: 'max',
    });
    expect(kimi3).not.toHaveProperty('supportsReasoningLevel');
    expect(kimi3).not.toHaveProperty('reasoningLevel');
  });

  it('groups membership models under Kimi Code rather than Moonshot', async () => {
    const controller = new SettingsModelSelectionController({
      state: createState(),
      resolveModelOptions,
      getRuntimeModelEntries: NO_RUNTIME_MODELS,
    });

    const { models } = await controller.buildSelectionData();

    expect(models.find((model) => model.name === 'kimiCoding')).toMatchObject({
      provider: 'kimiCode',
      label: 'Kimi for Coding',
    });
  });

  it('moves a stale helper fallback when disabling the effective helper model', async () => {
    const state = createState({
      enabledModels: ['gpt55', 'sonnet46T'],
      helperModel: 'removed-model',
    });
    const controller = new SettingsModelSelectionController({
      state,
      resolveModelOptions,
      getRuntimeModelEntries: NO_RUNTIME_MODELS,
    });

    expect((await controller.buildSelectionData()).helperModel).toBe('gpt55');

    await controller.setModelEnabled({ modelName: 'gpt55', enabled: false });

    expect(state.getEnabledModels()).toEqual(['sonnet46T']);
    expect(state.getHelperModel()).toBe('sonnet46T');
  });

  it('falls back to default models when the persisted enabled list is empty', async () => {
    const controller = new SettingsModelSelectionController({
      state: createState({ enabledModels: [] }),
      resolveModelOptions,
      getRuntimeModelEntries: NO_RUNTIME_MODELS,
    });

    const { models } = await controller.buildSelectionData();
    const enabled = models.filter((model) => model.enabled);

    // An empty persisted list must not blank out the helper-model dropdown.
    expect(enabled.length).toBeGreaterThan(0);
  });

  it('uses the runtime helper default when no helper model is configured', async () => {
    const controller = new SettingsModelSelectionController({
      state: createState({
        enabledModels: ['gpt55', 'sonnet46T'],
      }),
      resolveModelOptions,
      getRuntimeModelEntries: NO_RUNTIME_MODELS,
    });

    expect((await controller.buildSelectionData()).helperModel).toBe(
      DEFAULT_HELPER_MODEL,
    );
  });

  it('includes discovered Copilot models without exposing static Copilot entries', async () => {
    const runtimeConfig = {
      name: 'copilot:sonnet46',
      label: 'Copilot · Claude Sonnet 4.6',
      provider: 'copilot',
      contextWindow: 160_000,
      inputPrice: 0,
      outputPrice: 0,
      deprecated: false,
      retired: false,
      capabilities: {},
    } as ModelConfig;
    const controller = new SettingsModelSelectionController({
      state: createState(),
      getRuntimeModelEntries: async () => [
        ['copilot:sonnet46', runtimeConfig] as const,
      ],
      resolveModelOptions: async (models) =>
        models.map((model) => ({
          value: model,
          label: model === 'copilot:sonnet46' ? runtimeConfig.label : model,
          provider: model === 'copilot:sonnet46' ? 'copilot' : 'openai',
          availability:
            model === 'copilot:sonnet46'
              ? 'copilot-consent-required'
              : 'provider-key',
          availabilityLabel:
            model === 'copilot:sonnet46'
              ? 'Copilot consent required'
              : 'API key set',
          requiresKey: false,
          disabled: model === 'copilot:sonnet46',
        })),
    });

    const { models } = await controller.buildSelectionData();

    expect(models).toContainEqual(
      expect.objectContaining({
        name: 'copilot:sonnet46',
        provider: 'copilot',
        availability: 'copilot-consent-required',
      }),
    );
    expect(models.filter((model) => model.provider === 'copilot')).toHaveLength(
      1,
    );
  });
});
