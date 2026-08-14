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
  initial: Partial<{
    enabledModels: readonly string[];
    helperModel: string;
    reasoningLevelOverrides: Record<string, string>;
    preferShortModelNames: boolean;
  }> = {},
): SettingsModelSelectionState {
  const state = {
    enabledModels: initial.enabledModels,
    helperModel: initial.helperModel,
    reasoningLevelOverrides: initial.reasoningLevelOverrides,
    preferShortModelNames: initial.preferShortModelNames,
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
    getCopilotRoutes: async () => new Map(),
    getPreferredCopilotRouteModels: () => [],
    ...overrides,
  });
}

// A discovered sonnet46 Copilot route with the editor's context ceiling and
// subscription pricing, optionally with capabilities overridden.
function sonnet46CopilotRoutes(
  access: CopilotModelRoute['access'],
  capabilities?: CopilotModelRoute['effectiveConfig']['capabilities'],
): ReadonlyMap<string, CopilotModelRoute> {
  return new Map<string, CopilotModelRoute>([
    [
      'sonnet46',
      {
        access,
        reference: { vendor: 'copilot', id: 'claude-sonnet-4.6' },
        effectiveConfig: {
          ...MODEL_CONFIGS.sonnet46,
          ...(capabilities === undefined ? {} : { capabilities }),
          contextWindow: 200_000,
          inputPrice: 0,
          outputPrice: 0,
        },
      },
    ],
  ]);
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

  it('pins a disabled helper to the built-in default', async () => {
    const state = createState({
      enabledModels: ['gpt55', 'sonnet46T'],
      helperModel: 'gpt55',
    });
    const controller = createController({ state });

    expect((await controller.buildSelectionData()).helperModel).toBe('gpt55');

    await controller.setModelEnabled({ modelName: 'gpt55', enabled: false });

    expect(state.getEnabledModels()).toEqual(['sonnet46T']);
    expect(state.getHelperModel()).toBe(DEFAULT_HELPER_MODEL);
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

  it('keeps a preferred undiscovered Copilot route visible for opt-out', async () => {
    const controller = createController({
      getPreferredCopilotRouteModels: () => ['sonnet46'],
    });

    expect((await controller.buildSelectionData()).copilotModels).toEqual([
      {
        name: 'sonnet46',
        label: MODEL_CONFIGS.sonnet46.label,
        access: 'unavailable',
        preferred: true,
      },
    ]);
  });

  it('does not expose reasoning controls for a preferred VS Code route', async () => {
    const controller = createController({
      getPreferredCopilotRouteModels: () => ['sonnet46'],
      getCopilotRoutes: async () =>
        sonnet46CopilotRoutes('allowed', {
          ...MODEL_CONFIGS.sonnet46.capabilities,
          supportsReasoningEffort: false,
          maxReasoningEffort: undefined,
          supportedReasoningEfforts: undefined,
        }),
    });

    const sonnet = (await controller.buildSelectionData()).models.find(
      (model) => model.name === 'sonnet46',
    );
    expect(MODEL_CONFIGS.sonnet46.capabilities.supportsReasoningEffort).toBe(
      true,
    );
    expect(sonnet).not.toHaveProperty('supportsReasoningLevel');
    expect(sonnet).not.toHaveProperty('reasoningLevel');
  });

  it('surfaces discovered Copilot routes as route status, never as picker rows', async () => {
    const controller = createController({
      getCopilotRoutes: async () => sonnet46CopilotRoutes('consent-required'),
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
