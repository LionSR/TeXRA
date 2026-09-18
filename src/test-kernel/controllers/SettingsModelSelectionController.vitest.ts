import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';

import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import {
  getEnabledModels,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import { buildBaseModelOption, DEFAULT_MODELS } from '@model/modelOptionsBasic';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { CopilotModelRoute } from '@model/runtimeModelRegistry';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ModelOptionData } from '@shared/schemas';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

/** The controller's deps are file-local; derive them from its constructor. */
type SettingsModelSelectionControllerDeps = ConstructorParameters<
  typeof SettingsModelSelectionController<never>
>[0];

// Stub the injected availability resolver so the controller stays decoupled
// from the global platform / server-side key service in unit tests.
const modelOptions = (models: readonly string[]): ModelOptionData[] =>
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
    }));

const resolveModelOptions = (
  _stores: ModelOptionStores,
  models: readonly string[],
): Effect.Effect<ModelOptionData[]> => Effect.succeed(modelOptions(models));

function createController(
  overrides: Partial<SettingsModelSelectionControllerDeps> = {},
): SettingsModelSelectionController {
  return new SettingsModelSelectionController<never>({
    stores: makeFakeSettingsStores().stores,
    secrets: new FakeSecrets(),
    resolveModelOptions,
    copilotRoutes: Effect.succeed(new Map()),
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
        version: '2026-07',
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
  it('does not expose a reasoning selector for Kimi K3 fixed max effort', async () => {
    const controller = createController({
      stores: {
        ...makeFakeSettingsStores().stores,
        globalState: new FakeStateStore({
          [GlobalStateKey.REASONING_LEVELS]: { kimi3: 'low' },
        }),
      },
    });

    const { models } = await Effect.runPromise(controller.buildSelectionData());
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

    const { models } = await Effect.runPromise(controller.buildSelectionData());

    expect(models.find((model) => model.name === 'kimiCoding')).toMatchObject({
      provider: 'kimiCode',
      label: 'Kimi for Coding',
    });
  });

  it('keeps Kimi K3 under Moonshot while preserving its effective route', async () => {
    const controller = createController({
      resolveModelOptions: (_stores, models) =>
        Effect.succeed(
          modelOptions(models).map((option) =>
            option.value === 'kimi3'
              ? {
                  ...option,
                  provider: 'kimiCode',
                  routeLabel: 'Via Kimi Code',
                }
              : option,
          ),
        ),
    });

    expect(
      (await Effect.runPromise(controller.buildSelectionData())).models.find(
        (model) => model.name === 'kimi3',
      ),
    ).toMatchObject({
      provider: 'moonshot',
      routeLabel: 'Via Kimi Code',
    });
  });

  it('pins a disabled helper to the built-in default', async () => {
    const globalState = new FakeStateStore({
      [GlobalStateKey.MODEL_SELECTION]: {
        enabledExtras: ['gpt55'],
        disabledDefaults: [],
      },
      [GlobalStateKey.HELPER_MODEL]: 'gpt55',
    });
    const controller = createController({
      stores: { ...makeFakeSettingsStores().stores, globalState },
    });

    expect(
      (await Effect.runPromise(controller.buildSelectionData())).helperModel,
    ).toBe('gpt55');

    await Effect.runPromise(
      controller.setModelEnabled({ modelName: 'gpt55', enabled: false }),
    );

    expect(globalState.get(GlobalStateKey.MODEL_SELECTION)).toEqual({
      enabledExtras: [],
      disabledDefaults: [],
    });
    expect(globalState.get(GlobalStateKey.HELPER_MODEL)).toBe(
      DEFAULT_HELPER_MODEL,
    );
  });

  it('refuses to disable the last remaining model', async () => {
    const onlyGpt55 = {
      enabledExtras: ['gpt55'],
      disabledDefaults: DEFAULT_MODELS,
    };
    const globalState = new FakeStateStore({
      [GlobalStateKey.MODEL_SELECTION]: onlyGpt55,
    });
    const controller = createController({
      stores: { ...makeFakeSettingsStores().stores, globalState },
    });

    await expect(
      Effect.runPromise(
        controller.setModelEnabled({ modelName: 'gpt55', enabled: false }),
      ),
    ).rejects.toThrow(/at least one model/i);
    expect(globalState.get(GlobalStateKey.MODEL_SELECTION)).toEqual(onlyGpt55);
  });

  it('falls back to default models when every enabled model has retired', async () => {
    const globalState = new FakeStateStore({
      [GlobalStateKey.MODEL_SELECTION]: {
        enabledExtras: ['grok4'],
        disabledDefaults: DEFAULT_MODELS,
      },
    });
    const controller = createController({
      stores: { ...makeFakeSettingsStores().stores, globalState },
    });

    const { models } = await Effect.runPromise(controller.buildSelectionData());
    const enabled = models.filter((model) => model.enabled);

    // A retired-only selection must not blank out the helper-model dropdown.
    expect(enabled.length).toBeGreaterThan(0);

    // A toggle edits the fallback the picker shows, not the hidden delta.
    const [first] = DEFAULT_MODELS;
    await Effect.runPromise(
      controller.setModelEnabled({ modelName: first, enabled: false }),
    );
    expect(globalState.get(GlobalStateKey.MODEL_SELECTION)).toEqual({
      enabledExtras: [],
      disabledDefaults: [first],
    });

    // Turned back on, it stays on even after the curated defaults drop it.
    await Effect.runPromise(
      controller.setModelEnabled({ modelName: first, enabled: true }),
    );
    expect(globalState.get(GlobalStateKey.MODEL_SELECTION)).toEqual({
      enabledExtras: [first],
      disabledDefaults: [],
    });
    const defaults = DEFAULT_MODELS as string[];
    defaults.splice(defaults.indexOf(first), 1);
    try {
      expect(getEnabledModels(globalState)).toContain(first);
    } finally {
      defaults.unshift(first);
    }
  });

  it('shows the defaults when the stored selection is malformed', async () => {
    const enabledNames = async (controller: SettingsModelSelectionController) =>
      (await Effect.runPromise(controller.buildSelectionData())).models
        .filter((model) => model.enabled)
        .map((model) => model.name);
    const malformed = createController({
      stores: {
        ...makeFakeSettingsStores().stores,
        globalState: new FakeStateStore({
          [GlobalStateKey.MODEL_SELECTION]: { enabledExtras: null },
        }),
      },
    });

    expect(await enabledNames(malformed)).toEqual(
      await enabledNames(createController()),
    );
  });

  it('keeps a preferred undiscovered Copilot route visible for opt-out', async () => {
    const controller = createController({
      getPreferredCopilotRouteModels: () => ['sonnet46'],
    });

    expect(
      (await Effect.runPromise(controller.buildSelectionData())).copilotModels,
    ).toEqual([
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
      copilotRoutes: Effect.succeed(
        sonnet46CopilotRoutes('allowed', {
          ...MODEL_CONFIGS.sonnet46.capabilities,
          supportsReasoningEffort: false,
          maxReasoningEffort: undefined,
          supportedReasoningEfforts: undefined,
        }),
      ),
    });

    const sonnet = (
      await Effect.runPromise(controller.buildSelectionData())
    ).models.find((model) => model.name === 'sonnet46');
    expect(MODEL_CONFIGS.sonnet46.capabilities.supportsReasoningEffort).toBe(
      true,
    );
    expect(sonnet).not.toHaveProperty('supportsReasoningLevel');
    expect(sonnet).not.toHaveProperty('reasoningLevel');
  });

  it('surfaces discovered Copilot routes as route status, never as picker rows', async () => {
    const controller = createController({
      copilotRoutes: Effect.succeed(sonnet46CopilotRoutes('consent-required')),
    });

    const { models, copilotModels } = await Effect.runPromise(
      controller.buildSelectionData(),
    );

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
