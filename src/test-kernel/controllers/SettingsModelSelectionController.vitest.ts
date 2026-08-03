import { describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { MAX_TIER } from '@auth/config';
import {
  SettingsModelSelectionController,
  type SettingsModelSelectionControllerDeps,
  type SettingsModelSelectionState,
} from '@controllers/settingsView/SettingsModelSelectionController';
import { buildBasicModelOptionsData } from '@model/modelOptionsBasic';
import type { CopilotModelRoute } from '@model/runtimeModelRegistry';
import type { ModelOptionData } from '@shared/schemas';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';

const NO_COPILOT_ROUTES = async (): Promise<
  ReadonlyMap<string, CopilotModelRoute>
> => new Map();

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
    enabledModels: readonly string[];
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

function createController(
  overrides: Partial<SettingsModelSelectionControllerDeps> = {},
): SettingsModelSelectionController {
  return new SettingsModelSelectionController({
    state: createState(),
    resolveModelOptions,
    getCopilotRoutes: NO_COPILOT_ROUTES,
    ...overrides,
  });
}

describe('SettingsModelSelectionController', () => {
  it('uses canonical tier constants for included-access reasoning caps', async () => {
    const controller = createController({
      useIncludedAccess: () => true,
      getUserTier: () => MAX_TIER,
    });

    const { models } = await controller.buildSelectionData();
    const gpt55 = models.find((model) => model.name === 'gpt55');

    expect(gpt55).toMatchObject({
      supportsReasoningLevel: true,
      includedAccessReasoningCap: 'high',
    });
  });

  it('does not expose a reasoning selector for Kimi K3 fixed max effort', async () => {
    const controller = createController({
      state: createState({ reasoningLevelOverrides: { kimi3: 'low' } }),
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
    const controller = createController();

    const { models } = await controller.buildSelectionData();

    expect(models.find((model) => model.name === 'kimiCoding')).toMatchObject({
      provider: 'kimiCode',
      label: 'Kimi for Coding',
    });
  });

  it('keeps Kimi K3 under Moonshot while preserving its effective route', async () => {
    const controller = createController({
      resolveModelOptions: async (models) =>
        (await resolveModelOptions(models)).map((option) =>
          option.value === 'kimi3'
            ? {
                ...option,
                provider: 'kimiCode',
                routeLabel: 'Via Kimi Code',
              }
            : option,
        ),
    });

    expect(
      (await controller.buildSelectionData()).models.find(
        (model) => model.name === 'kimi3',
      ),
    ).toMatchObject({
      provider: 'moonshot',
      routeLabel: 'Via Kimi Code',
    });
  });

  it('moves a stale helper fallback when disabling the effective helper model', async () => {
    const state = createState({
      enabledModels: ['gpt55', 'sonnet46T'],
      helperModel: 'removed-model',
    });
    const controller = createController({ state });

    expect((await controller.buildSelectionData()).helperModel).toBe('gpt55');

    await controller.setModelEnabled({ modelName: 'gpt55', enabled: false });

    expect(state.getEnabledModels()).toEqual(['sonnet46T']);
    expect(state.getHelperModel()).toBe('sonnet46T');
  });

  it('falls back to default models when the persisted enabled list is empty', async () => {
    const controller = createController({
      state: createState({ enabledModels: [] }),
    });

    const { models } = await controller.buildSelectionData();
    const enabled = models.filter((model) => model.enabled);

    // An empty persisted list must not blank out the helper-model dropdown.
    expect(enabled.length).toBeGreaterThan(0);
  });

  it('uses the runtime helper default when no helper model is configured', async () => {
    const controller = createController({
      state: createState({ enabledModels: ['gpt55', 'sonnet46T'] }),
    });

    expect((await controller.buildSelectionData()).helperModel).toBe(
      DEFAULT_HELPER_MODEL,
    );
  });

  it('surfaces discovered Copilot routes as route status, never as picker rows', async () => {
    const controller = createController({
      getCopilotRoutes: async () =>
        new Map<string, CopilotModelRoute>([
          [
            'sonnet46',
            {
              access: 'consent-required',
              reference: { vendor: 'copilot', id: 'claude-sonnet-4.6' },
            },
          ],
        ]),
    });

    const { models, copilotModels } = await controller.buildSelectionData();

    expect(copilotModels).toEqual([
      {
        name: 'sonnet46',
        label: MODEL_CONFIGS.sonnet46.label,
        access: 'consent-required',
        preferred: false,
      },
    ]);
    // The route's base model keeps its own single row; no `copilot:` identity
    // and no Copilot-provider row ever enters the picker.
    expect(
      models.filter(
        (model) =>
          model.name.startsWith('copilot:') || model.provider === 'copilot',
      ),
    ).toEqual([]);
    expect(models.filter((model) => model.name === 'sonnet46')).toHaveLength(1);
  });
});
