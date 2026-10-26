import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { lookup } from 'llm-zoo';

import {
  getEnabledModels,
  type ModelOption,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import {
  DEFAULT_HELPER_MODEL,
  DEFAULT_MODELS,
} from '@shared/constants/defaultModels';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { SettingsModelSelectionController } from '@texra/controllers/settingsView/SettingsModelSelectionController';

const GPT55 = 'openai/gpt-5.5-2026-04-23';

/** The controller's deps are file-local; derive them from its constructor. */
type SettingsModelSelectionControllerDeps = ConstructorParameters<
  typeof SettingsModelSelectionController<never>
>[0];

// Stub the injected availability resolver so the controller stays decoupled
// from the global platform / server-side key service in unit tests.
const resolveModelOptions = (
  _stores: ModelOptionStores,
  models: readonly string[],
): Effect.Effect<ModelOption[]> =>
  Effect.succeed(
    models.map((model): ModelOption => {
      const config = lookup(model);
      return config
        ? {
            model,
            availability: 'provider-key',
            published: config,
            config,
            // The controller never reads the route; any ready route will do.
            route: {
              kind: 'api-key',
              provider: 'openai',
              usageRoute: 'api-key',
            },
            source: config.provider,
            savedEffort: undefined,
            reasoning: undefined,
          }
        : {
            model,
            availability: 'unknown-model',
            unavailableReason: `Model "${model}" is not recognized.`,
          };
    }),
  );

function createController(
  overrides: Partial<SettingsModelSelectionControllerDeps> = {},
): SettingsModelSelectionController {
  return new SettingsModelSelectionController<never>({
    stores: makeFakeSettingsStores().stores,
    secrets: new FakeSecrets(),
    resolveModelOptions,
    ...overrides,
  });
}

describe('SettingsModelSelectionController', () => {
  it.effect('resolves a disabled helper to the built-in default', () =>
    Effect.gen(function* () {
      const globalState = new FakeStateStore({
        [GlobalStateKey.MODEL_SELECTION]: {
          enabledExtras: [GPT55],
          disabledDefaults: [],
        },
        [GlobalStateKey.HELPER_MODEL]: GPT55,
      });
      const controller = createController({
        stores: { ...makeFakeSettingsStores().stores, globalState },
      });

      expect((yield* controller.buildSelectionData()).helperModel).toBe(GPT55);

      yield* controller.setModelEnabled({ modelName: GPT55, enabled: false });

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
        enabledExtras: [GPT55],
        disabledDefaults: DEFAULT_MODELS,
      };
      const globalState = new FakeStateStore({
        [GlobalStateKey.MODEL_SELECTION]: onlyGpt55,
      });
      const controller = createController({
        stores: { ...makeFakeSettingsStores().stores, globalState },
      });

      const error = yield* Effect.flip(
        controller.setModelEnabled({ modelName: GPT55, enabled: false }),
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
            enabledExtras: ['xai/grok-4-0709'],
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
});
