import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { MODEL_CONFIGS, lookup } from 'llm-zoo';

import {
  getEnabledModels,
  type ModelOption,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import type { CopilotModelRoute } from '@model/copilotRouting';
import {
  DEFAULT_HELPER_MODEL,
  DEFAULT_MODELS,
} from '@shared/constants/defaultModels';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { SettingsModelSelectionController } from '@texra/controllers/settingsView/SettingsModelSelectionController';

const GPT55 = 'openai/gpt-5.5-2026-04-23';
// Live (not deprecated): a stored preference for a deprecated model drops out at read.
const SONNET55 = 'anthropic/claude-sonnet-5-5';
const OPUS55 = 'anthropic/claude-opus-5-5';

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
            route: { kind: 'openrouter' },
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
    copilotRoutes: Effect.succeed(new Map()),
    ...overrides,
  });
}

// A discovered Opus 5.5 Copilot route with the editor's context ceiling and
// subscription pricing, optionally with capabilities overridden.
function opus55CopilotRoutes(
  access: CopilotModelRoute['access'],
  capabilities?: CopilotModelRoute['effectiveConfig']['capabilities'],
): ReadonlyMap<string, CopilotModelRoute> {
  return new Map<string, CopilotModelRoute>([
    [
      OPUS55,
      {
        access,
        reference: { vendor: 'copilot', id: 'claude-opus-5.5' },
        version: '2026-07',
        effectiveConfig: {
          ...MODEL_CONFIGS[OPUS55],
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
          stores: {
            ...makeFakeSettingsStores().stores,
            globalState: new FakeStateStore({
              [GlobalStateKey.COPILOT_ROUTE_MODELS]: [SONNET55],
            }),
          },
        });

        expect((yield* controller.buildSelectionData()).copilotModels).toEqual([
          {
            name: SONNET55,
            label: MODEL_CONFIGS[SONNET55].label,
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
            opus55CopilotRoutes('consent-required'),
          ),
        });

        const { models, copilotModels } =
          yield* controller.buildSelectionData();

        expect(copilotModels).toEqual([
          {
            name: OPUS55,
            label: MODEL_CONFIGS[OPUS55].label,
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
        expect(models.filter((model) => model.name === OPUS55)).toHaveLength(1);
      }),
  );
});
