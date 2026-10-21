// Third-party imports
import { it } from '@effect/vitest';
import { beforeEach, describe, expect, vi } from 'vitest';
import { Effect } from 'effect';

// Local imports
import { modelRefOf } from '@texra-ai/llm';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';

const readModelOptions = vi.hoisted(() =>
  vi.fn((): Effect.Effect<readonly { unavailableReason?: string }[]> =>
    Effect.succeed([{}]),
  ),
);

vi.mock('@model/computeModelOptions', () => ({
  CALLING_SCOPE: <A>(read: () => A): A => read(),
  // Every helper a case names counts as enabled, so the configured choice
  // stands and the preference alone decides.
  getEnabledModels: (state: { get: (key: string) => Effect.Effect<unknown> }) =>
    Effect.map(state.get(HELPER_KEY), (model) => [
      modelRefOf(String(model)) ?? String(model),
    ]),
  readModelOptions,
}));
vi.mock('llm-zoo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('llm-zoo')>()),
  MODEL_CONFIGS,
}));

const HELPER_KEY = vi.hoisted(() => 'polishModel');

/** The launching run's stores; each case writes its helper model there. */
const { stores, secrets } = makeFakeSettingsStores();
const STORES = { ...stores, secrets };

function withHelper(helper: string) {
  return STORES.globalState.update(GlobalStateKey.HELPER_MODEL, helper);
}

const MODEL_CONFIGS = vi.hoisted(() => ({
  deepseek: { capabilities: { supportsFunctionCalling: true } },
  chatonly: { capabilities: { supportsFunctionCalling: false } },
  // Known model whose capabilities omit supportsFunctionCalling: the provider
  // adapters treat this as "no function calling".
  undeclared: { capabilities: {} },
}));

function configFor(model: string): AgentConfig {
  return { agent: 'latexFixer', model } as unknown as AgentConfig;
}

describe('applyHelperModelPreference', () => {
  beforeEach(() => {
    vi.resetModules();
    readModelOptions.mockClear();
  });

  function resolve(config: AgentConfig) {
    // `vi.resetModules()` runs per case, so the module under test is imported
    // inside the program the case runs.
    return Effect.promise(() => import('@agent/runtime/helperModelName')).pipe(
      Effect.flatMap(({ applyHelperModelPreference }) =>
        applyHelperModelPreference(config, STORES),
      ),
      // The real `readModelOptions` requires the service; the mock
      // replaces it, but the requirement stays on the program's type.
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
    );
  }

  it.effect.each([
    { helper: 'opus', scenario: 'the helper model already equals it' },
    {
      helper: 'chatonly',
      scenario: 'a helper cannot call functions',
    },
    {
      helper: 'mysteryModel',
      scenario: 'the helper model is unknown to the registry',
    },
    // Capabilities present but supportsFunctionCalling omitted — the provider
    // adapters would strip the function tools, so don't swap.
    {
      helper: 'undeclared',
      scenario: "the helper model doesn't declare function calling",
    },
  ])('keeps the selected model when $scenario', ({ helper }) =>
    Effect.gen(function* () {
      yield* withHelper(helper);

      const result = yield* resolve(configFor('opus'));

      expect(result.model).toBe('opus');
      expect(readModelOptions).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'falls back to the selected model when the helper model is unavailable',
    () =>
      Effect.gen(function* () {
        yield* withHelper('deepseek/deepseek-flash@none');
        readModelOptions.mockReturnValueOnce(
          Effect.succeed([{ unavailableReason: 'No API key configured.' }]),
        );

        const result = yield* resolve(configFor('opus'));

        expect(result.model).toBe('opus');
      }),
  );
});
