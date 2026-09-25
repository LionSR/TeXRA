import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import {
  getEnabledModels,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import { buildBaseModelOption, DEFAULT_MODELS } from '@model/modelOptionsBasic';
import type { CopilotModelRoute } from '@model/copilotRouting';
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
      const config = MODEL_CONFIGS[model];
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
    getPreferredCopilotRouteModels: () => Effect.succeed([]),
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
  it.effect('resolves a disabled helper to the built-in default', () =>
    Effect.gen(function* () {
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

      expect((yield* controller.buildSelectionData()).helperModel).toBe(
        'gpt55',
      );

      yield* controller.setModelEnabled({ modelName: 'gpt55', enabled: false });

      expect(yield* globalState.get(GlobalStateKey.MODEL_SELECTION)).toEqual({
        enabledExtras: [],
        disabledDefaults: [],
      });
      expect((yield* controller.buildSelectionData()).helperModel).toBe(
        DEFAULT_HELPER_MODEL,
      );
    }),
  );

  it.effect('refuses to disable the last remaining model', () =>
    Effect.gen(function* () {
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

      const error = yield* Effect.flip(
        controller.setModelEnabled({ modelName: 'gpt55', enabled: false }),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/at least one model/i);
      expect(yield* globalState.get(GlobalStateKey.MODEL_SELECTION)).toEqual(
        onlyGpt55,
      );
    }),
  );

  it.effect(
    'falls back to default models when every enabled model has retired',
    () =>
      Effect.gen(function* () {
        const globalState = new FakeStateStore({
          [GlobalStateKey.MODEL_SELECTION]: {
            enabledExtras: ['grok4'],
            disabledDefaults: DEFAULT_MODELS,
          },
        });
        const controller = createController({
          stores: { ...makeFakeSettingsStores().stores, globalState },
        });

        const { models } = yield* controller.buildSelectionData();
        const enabled = models.filter((model) => model.enabled);

        // A retired-only selection must not blank out the helper-model dropdown.
        expect(enabled.length).toBeGreaterThan(0);

        // A toggle edits the fallback the picker shows, not the hidden delta.
        const [first] = DEFAULT_MODELS;
        yield* controller.setModelEnabled({ modelName: first, enabled: false });
        expect(yield* globalState.get(GlobalStateKey.MODEL_SELECTION)).toEqual({
          enabledExtras: [],
          disabledDefaults: [first],
        });

        // Turned back on, it stays on even after the curated defaults drop it.
        yield* controller.setModelEnabled({ modelName: first, enabled: true });
        expect(yield* globalState.get(GlobalStateKey.MODEL_SELECTION)).toEqual({
          enabledExtras: [first],
          disabledDefaults: [],
        });
        const defaults = DEFAULT_MODELS as string[];
        defaults.splice(defaults.indexOf(first), 1);
        try {
          expect(yield* getEnabledModels(globalState)).toContain(first);
        } finally {
          defaults.unshift(first);
        }
      }),
  );

  it.effect('shows the defaults when the stored selection is malformed', () =>
    Effect.gen(function* () {
      const enabledNames = (controller: SettingsModelSelectionController) =>
        controller
          .buildSelectionData()
          .pipe(
            Effect.map(({ models }) =>
              models
                .filter((model) => model.enabled)
                .map((model) => model.name),
            ),
          );
      const malformed = createController({
        stores: {
          ...makeFakeSettingsStores().stores,
          globalState: new FakeStateStore({
            [GlobalStateKey.MODEL_SELECTION]: { enabledExtras: null },
          }),
        },
      });

      expect(yield* enabledNames(malformed)).toEqual(
        yield* enabledNames(createController()),
      );
    }),
  );

  it.effect(
    'keeps a preferred undiscovered Copilot route visible for opt-out',
    () =>
      Effect.gen(function* () {
        const controller = createController({
          getPreferredCopilotRouteModels: () => Effect.succeed(['sonnet46']),
        });

        expect((yield* controller.buildSelectionData()).copilotModels).toEqual([
          {
            name: 'sonnet46',
            label: MODEL_CONFIGS.sonnet46.label,
            access: 'unavailable',
            preferred: true,
          },
        ]);
      }),
  );

  it.effect(
    'surfaces discovered Copilot routes as route status, never as picker rows',
    () =>
      Effect.gen(function* () {
        const controller = createController({
          copilotRoutes: Effect.succeed(
            sonnet46CopilotRoutes('consent-required'),
          ),
        });

        const { models, copilotModels } =
          yield* controller.buildSelectionData();

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
        expect(
          models.filter((model) => model.name === 'sonnet46'),
        ).toHaveLength(1);
      }),
  );
});
