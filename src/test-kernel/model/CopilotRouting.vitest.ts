import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';
import { describe, expect, vi } from 'vitest';

import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import {
  copilotRouteUnavailableReason,
  discoverCopilotRoutes,
  getRuntimeModelDirectFallback,
} from '@model/copilotRouting';
import { apiKeySecretName } from '@model/apiProviders';
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import type {
  LanguageModelInfo,
  LanguageModelPort,
} from '@platform/languageModel';
import { LanguageModel } from '@platform/languageModel';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  fakeHostLanguageModel,
  hostStores,
  installPlatform,
} from '@test/support/setupPlatform';

/**
 * The availability read over the installed fake host's language-model port,
 * provided explicitly because the bare `it.effect` runtime does not carry the
 * process services.
 */
const availabilityInputs = (
  ...args: Parameters<typeof readModelAvailabilityInputs>
) =>
  readModelAvailabilityInputs(...args).pipe(
    Effect.provide(LanguageModel.layer(fakeHostLanguageModel)),
  );

// The discovered-editor-model fixture must track an llm-zoo base model that
// is active (neither deprecated nor retired) and Copilot-documented (carries
// `copilotFullName`): route resolution filters deprecated/retired configs and
// matches the editor id against the registry's Copilot name. gemini31p
// satisfies both in llm-zoo 1.28.0; gemini36f, the previous pick, is
// deprecated there.
const GEMINI_PRO: LanguageModelInfo = {
  id: 'gemini-3.1-pro-preview',
  name: 'Gemini 3.1 Pro',
  family: 'gemini-3.1-pro-preview',
  vendor: 'copilot',
  version: '2026-07',
  maxInputTokens: 160_000,
  access: 'allowed',
};

const GPT_56_TERRA: LanguageModelInfo = {
  id: 'gpt-5.6-terra',
  name: 'GPT-5.6 Terra',
  family: 'gpt-5.6-terra',
  vendor: 'copilot',
  version: '2026-07',
  maxInputTokens: 128_000,
  access: 'allowed',
};

function languageModelPort(
  models: readonly LanguageModelInfo[],
): LanguageModelPort {
  return {
    isAvailable: () => true,
    selectModels: vi.fn(() => Effect.succeed(models)),
    onDidChange: () => ({ dispose() {} }),
  };
}

/** Discover over `models` through a port of their own. */
const discover = (...models: readonly LanguageModelInfo[]) =>
  discoverCopilotRoutes().pipe(
    Effect.provide(LanguageModel.layer(languageModelPort(models))),
  );

function failingDiscoveryPort(): LanguageModelPort {
  return {
    ...languageModelPort([]),
    selectModels: () => Effect.fail(new Error('native discovery failed')),
  };
}

function googleKeySecrets(): Record<string, string> {
  return { [apiKeySecretName('google')]: 'sk-google' };
}

describe('Copilot route discovery', () => {
  it.effect(
    'maps a discovered editor model to a route on its canonical base model',
    () =>
      Effect.gen(function* () {
        const routes = yield* discover(GEMINI_PRO);

        expect(routes.get('gemini31p')).toEqual(
          expect.objectContaining({
            access: 'allowed',
            reference: { vendor: 'copilot', id: GEMINI_PRO.id },
            version: GEMINI_PRO.version,
            effectiveConfig: expect.objectContaining({
              name: 'gemini31p',
              contextWindow: GEMINI_PRO.maxInputTokens,
              inputPrice: 0,
              outputPrice: 0,
              capabilities: expect.objectContaining({
                supportsReasoningEffort: false,
              }),
            }),
          }),
        );
        expect(MODEL_CONFIGS.gemini31p.label).not.toContain('Copilot');
      }),
  );

  it.effect(
    'resolves duplicate editor versions deterministically to the newest',
    () =>
      Effect.gen(function* () {
        const routes = yield* discover(
          {
            ...GEMINI_PRO,
            id: 'gemini-3.1-pro-preview-old',
            version: '2026-01',
          },
          { ...GEMINI_PRO, id: 'gemini-3.1-pro-preview', version: '2026-07' },
        );

        expect(routes.get('gemini31p')?.reference).toEqual({
          vendor: 'copilot',
          id: 'gemini-3.1-pro-preview',
        });
      }),
  );

  it.effect(
    'omits editor models whose capabilities TeXRA cannot establish',
    () =>
      Effect.gen(function* () {
        const routes = yield* discover({
          ...GEMINI_PRO,
          id: 'future-model',
          family: 'future-model',
          name: 'Future model',
        });

        expect([...routes.keys()]).toEqual([]);
      }),
  );

  it('reports the direct fallback for a base model and a legacy copilot id', () => {
    expect(getRuntimeModelDirectFallback('gemini31p', false)).toEqual({
      model: 'gemini31p',
      provider: 'google',
    });
    expect(getRuntimeModelDirectFallback('gemini31p', true)).toEqual({
      model: 'gemini31p',
      provider: 'openRouter',
    });
    expect(getRuntimeModelDirectFallback('gpt56-', false)).toEqual({
      model: 'gpt56-',
      provider: 'openai',
    });
  });

  it.effect('reports no route error only when the route is allowed', () =>
    Effect.gen(function* () {
      const routes = yield* discover(GEMINI_PRO);
      expect(
        copilotRouteUnavailableReason('gemini31p', routes.get('gemini31p')),
      ).toBeUndefined();
      // A model the editor does not offer cannot route.
      expect(
        copilotRouteUnavailableReason('gpt56-', routes.get('gpt56-')),
      ).toMatch(/does not currently/);
    }),
  );
});

describe('Copilot route in model pickers', () => {
  it.effect(
    'shows a base model available both directly and through Copilot exactly once',
    () =>
      Effect.gen(function* () {
        const port = languageModelPort([GEMINI_PRO]);
        yield* Effect.promise(() =>
          installPlatform(
            {
              globalState: {
                [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini31p'],
                [GlobalStateKey.REASONING_LEVELS]: { gemini31p: 'low' },
              },
              secrets: googleKeySecrets(),
            },
            { languageModel: port },
          ),
        );

        const options = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['gemini31p']),
        );

        expect(options).toHaveLength(1);
        expect(options[0]).toEqual(
          expect.objectContaining({
            value: 'gemini31p',
            availability: 'copilot-allowed',
            routeLabel: 'Via Copilot',
            reasoning: 'Default (provider managed)',
            context: '160K',
            cost: '$0.000/$0.000',
          }),
        );
      }),
  );

  it.effect('never appends route rows to the visible model list', () =>
    Effect.gen(function* () {
      const port = languageModelPort([GEMINI_PRO, GPT_56_TERRA]);
      yield* Effect.promise(() =>
        installPlatform(
          {
            globalState: {
              [GlobalStateKey.MODEL_SELECTION]: {
                enabledExtras: ['gpt55'],
                disabledDefaults: DEFAULT_MODELS,
              },
            },
          },
          { languageModel: port },
        ),
      );

      const options = modelOptionsFrom(
        yield* availabilityInputs(hostStores(), undefined),
      );

      expect(options.map((option) => option.value)).toEqual(['gpt55']);
    }),
  );

  it.effect(
    'reports consent-required on the base row without adding entries',
    () =>
      Effect.gen(function* () {
        const port = languageModelPort([
          { ...GEMINI_PRO, access: 'consent-required' },
        ]);
        yield* Effect.promise(() =>
          installPlatform(
            {
              globalState: {
                [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini31p'],
                [GlobalStateKey.MODEL_SELECTION]: {
                  enabledExtras: [],
                  disabledDefaults: DEFAULT_MODELS.filter(
                    (model) => model !== 'gemini31p',
                  ),
                },
              },
            },
            { languageModel: port },
          ),
        );

        const options = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), undefined),
        );

        expect(options).toHaveLength(1);
        expect(options[0]).toEqual(
          expect.objectContaining({
            value: 'gemini31p',
            availability: 'copilot-consent-required',
          }),
        );
      }),
  );

  it.effect(
    'reports an unavailable route instead of falling back to a direct key',
    () =>
      Effect.gen(function* () {
        const port = languageModelPort([
          { ...GEMINI_PRO, access: 'unavailable' },
        ]);
        yield* Effect.promise(() =>
          installPlatform(
            {
              globalState: {
                [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini31p'],
              },
              secrets: googleKeySecrets(),
            },
            { languageModel: port },
          ),
        );

        const options = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['gemini31p']),
        );

        expect(options).toHaveLength(1);
        expect(options[0]).toEqual(
          expect.objectContaining({
            value: 'gemini31p',
            availability: 'copilot-unavailable',
          }),
        );
      }),
  );

  it.effect('shows a preferred route unavailable when discovery fails', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform(
          {
            globalState: {
              [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini31p'],
            },
            secrets: googleKeySecrets(),
          },
          { languageModel: failingDiscoveryPort() },
        ),
      );

      const options = modelOptionsFrom(
        yield* availabilityInputs(hostStores(), ['gemini31p']),
      );

      expect(options[0]).toEqual(
        expect.objectContaining({
          value: 'gemini31p',
          availability: 'copilot-unavailable',
        }),
      );
    }),
  );

  it.effect('leaves non-preferred models on their ordinary routes', () =>
    Effect.gen(function* () {
      const port = languageModelPort([GEMINI_PRO]);
      yield* Effect.promise(() =>
        installPlatform(
          { secrets: googleKeySecrets() },
          { languageModel: port },
        ),
      );

      const options = modelOptionsFrom(
        yield* availabilityInputs(hostStores(), ['gemini31p']),
      );

      expect(options[0]).toEqual(
        expect.objectContaining({
          value: 'gemini31p',
          availability: 'provider-key',
        }),
      );
      expect(options[0]).not.toHaveProperty('routeLabel');
      // Nothing can land on Copilot, so the editor is never asked.
      expect(port.selectModels).not.toHaveBeenCalled();
    }),
  );
});
