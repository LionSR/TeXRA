// Third-party imports
import { it } from '@effect/vitest';
import { beforeEach, describe, expect, vi } from 'vitest';
import { Effect } from 'effect';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import { fakeStores } from '@test/support/FakePlatform';

const getHelperModelName = vi.hoisted(() => vi.fn());
const readModelAvailabilityInputs = vi.hoisted(() =>
  vi.fn(() => Effect.succeed({})),
);
const modelUnavailableReasonFrom = vi.hoisted(() => vi.fn());
const resolveRuntimeModelConfig = vi.hoisted(() => vi.fn());

vi.mock('@agent/runtime/helperModelName', () => ({ getHelperModelName }));
vi.mock('@model/computeModelOptions', () => ({
  readModelAvailabilityInputs,
  modelUnavailableReasonFrom,
}));
vi.mock('@model/runtimeModelRegistry', () => ({ resolveRuntimeModelConfig }));

/**
 * The launching run's stores. Both readers that would touch them
 * (`getHelperModelName`, the availability read) are mocked here, so the
 * bag only has to be the one the preference forwards.
 */
const STORES = fakeStores();

const MODEL_CONFIGS = {
  deepseek: { capabilities: { supportsFunctionCalling: true } },
  chatonly: { capabilities: { supportsFunctionCalling: false } },
  // Known model whose capabilities omit supportsFunctionCalling — the provider
  // adapters treat this as "no function calling".
  undeclared: { capabilities: {} },
};

function configFor(model: string, agentCategory = 'toolUse'): AgentConfig {
  return {
    agent: 'latexFixer',
    model,
    agentCategory,
  } as unknown as AgentConfig;
}

describe('applyHelperModelPreference', () => {
  beforeEach(() => {
    vi.resetModules();
    getHelperModelName.mockReset();
    readModelAvailabilityInputs.mockClear();
    modelUnavailableReasonFrom.mockReset();
    resolveRuntimeModelConfig.mockImplementation((model: string) =>
      Effect.succeed(
        Object.hasOwn(MODEL_CONFIGS, model)
          ? MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS]
          : undefined,
      ),
    );
  });

  function resolve(config: AgentConfig) {
    // `vi.resetModules()` runs per case, so the module under test is imported
    // inside the program the case runs.
    return Effect.promise(
      () => import('@agent/runtime/helperModelPreference'),
    ).pipe(
      Effect.flatMap(({ applyHelperModelPreference }) =>
        applyHelperModelPreference(config, STORES),
      ),
      // The real `resolveRuntimeModelConfig` requires the service; the mock
      // replaces it, but the requirement stays on the program's type.
      Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
    );
  }

  it.effect.each([
    { helper: 'opus', scenario: 'the helper model already equals it' },
    {
      helper: 'chatonly',
      scenario: 'a tool-use helper cannot call functions',
    },
    {
      helper: 'mysteryModel',
      scenario: 'the tool-use helper model is unknown to the registry',
    },
    // Capabilities present but supportsFunctionCalling omitted — the provider
    // adapters would strip the function tools, so don't swap.
    {
      helper: 'undeclared',
      scenario: "the tool-use helper model doesn't declare function calling",
    },
  ])('keeps the selected model when $scenario', ({ helper }) =>
    Effect.gen(function* () {
      getHelperModelName.mockReturnValue(helper);

      const result = yield* resolve(configFor('opus', 'toolUse'));

      expect(result.model).toBe('opus');
      expect(readModelAvailabilityInputs).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'swaps a workflow agent without applying the tool-capability guard',
    () =>
      Effect.gen(function* () {
        // A workflow agent doesn't use the tool-use flow, so a
        // non-function-calling helper is fine.
        getHelperModelName.mockReturnValue('chatonly');
        modelUnavailableReasonFrom.mockReturnValue(undefined);

        const result = yield* resolve(configFor('opus', 'workflow'));

        expect(result.model).toBe('chatonly');
        expect(readModelAvailabilityInputs).toHaveBeenCalledWith(
          STORES,
          ['chatonly'],
          // The launching run hands its session frame down; this suite calls
          // the preference directly, so it is the default "already in the
          // frame" one.
          expect.any(Function),
        );
      }),
  );

  it.effect(
    'falls back to the selected model when the helper model is unavailable',
    () =>
      Effect.gen(function* () {
        getHelperModelName.mockReturnValue('deepseek');
        modelUnavailableReasonFrom.mockReturnValue('No API key configured.');

        const result = yield* resolve(configFor('opus'));

        expect(result.model).toBe('opus');
      }),
  );
});
