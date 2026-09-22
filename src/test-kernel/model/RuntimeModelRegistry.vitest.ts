import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import {
  copilotRouteUnavailableReason,
  setCopilotRoutePreference,
} from '@model/copilotRouting';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import {
  copilotRouteForModel,
  discoveredCopilotRoutes,
  getRuntimeModelConfig,
  getRuntimeModelDirectFallback,
  invalidateRuntimeModelRegistry,
  refreshRuntimeModelRegistry,
  resolveRuntimeModelConfig,
} from '@model/runtimeModelRegistry';
import type {
  LanguageModelInfo,
  LanguageModelPort,
} from '@platform/languageModel';
import { LanguageModel } from '@platform/languageModel';
import { withProcessServices } from '@platform/processRuntime';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createDeferred } from '@test/support/asyncTestUtils';
import {
  fakeHostLanguageModel,
  hostStores,
  installedHost,
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

const GPT_56: LanguageModelInfo = {
  id: 'gpt-5.6',
  name: 'GPT-5.6',
  family: 'gpt-5.6',
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

async function installModels(
  ...models: readonly LanguageModelInfo[]
): Promise<LanguageModelPort> {
  const port = languageModelPort(models);
  await installPlatform({}, { languageModel: port });
  return port;
}

function failingDiscoveryPort(): LanguageModelPort {
  return {
    ...languageModelPort([]),
    selectModels: () => Effect.fail(new Error('native discovery failed')),
  };
}

function resetModelCaches(): void {
  invalidateRuntimeModelRegistry();
  invalidateApiKeyCache();
}

function googleKeySecrets(): Record<string, string> {
  return { [apiKeySecretName('google')]: 'sk-google' };
}

describe('runtime model registry', () => {
  beforeEach(resetModelCaches);
  afterEach(resetModelCaches);

  it.effect(
    'maps a discovered editor model to a route on its canonical base model',
    () =>
      Effect.gen(function* () {
        const port = yield* Effect.promise(() => installModels(GEMINI_PRO));

        yield* withProcessServices(
          testRuntime(),
          refreshRuntimeModelRegistry(),
        );

        expect(port.selectModels).toHaveBeenCalledWith({ vendor: 'copilot' });
        expect(copilotRouteForModel('gemini31p')).toEqual(
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
        expect(getRuntimeModelConfig('gemini31p')?.label).not.toContain(
          'Copilot',
        );
      }),
  );

  it.effect(
    'resolves duplicate editor versions deterministically to the newest',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installModels(
            {
              ...GEMINI_PRO,
              id: 'gemini-3.1-pro-preview-old',
              version: '2026-01',
            },
            {
              ...GEMINI_PRO,
              id: 'gemini-3.1-pro-preview',
              version: '2026-07',
            },
          ),
        );

        yield* withProcessServices(
          testRuntime(),
          refreshRuntimeModelRegistry(),
        );

        expect(copilotRouteForModel('gemini31p')?.reference).toEqual({
          vendor: 'copilot',
          id: 'gemini-3.1-pro-preview',
        });
      }),
  );

  it.effect(
    'omits editor models whose capabilities TeXRA cannot establish',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installModels({
            ...GEMINI_PRO,
            id: 'future-model',
            family: 'future-model',
            name: 'Future model',
          }),
        );

        yield* withProcessServices(
          testRuntime(),
          refreshRuntimeModelRegistry(),
        );

        expect(copilotRouteForModel('future-model')).toBeUndefined();
        expect([
          ...(yield* withProcessServices(
            testRuntime(),
            discoveredCopilotRoutes(),
          )).keys(),
        ]).toEqual([]);
      }),
  );

  it.effect(
    'reports the direct fallback for a base model and a legacy copilot id',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installModels(GEMINI_PRO, GPT_56));
        yield* withProcessServices(
          testRuntime(),
          refreshRuntimeModelRegistry(),
        );

        expect(getRuntimeModelDirectFallback('gemini31p', false)).toEqual({
          model: 'gemini31p',
          provider: 'google',
        });
        expect(getRuntimeModelDirectFallback('gemini31p', true)).toEqual({
          model: 'gemini31p',
          provider: 'openRouter',
        });
        expect(getRuntimeModelDirectFallback('gpt56', false)).toEqual({
          model: 'gpt56',
          provider: 'openai',
        });
      }),
  );

  it.effect(
    'reports no route error only when preferred Copilot access is allowed',
    () =>
      Effect.gen(function* () {
        const port = languageModelPort([GEMINI_PRO]);
        yield* Effect.promise(() =>
          installPlatform(
            {
              globalState: {
                [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gemini31p', 'gpt56'],
              },
            },
            { languageModel: port },
          ),
        );

        yield* withProcessServices(
          testRuntime(),
          refreshRuntimeModelRegistry(),
        );
        const { globalState } = installedHost().roots;
        expect(
          yield* copilotRouteUnavailableReason('gemini31p', globalState),
        ).toBeUndefined();
        // A preference for a model the editor does not offer cannot route.
        expect(
          yield* copilotRouteUnavailableReason('gpt56', globalState),
        ).toMatch(/does not currently/);

        yield* setCopilotRoutePreference('gemini31p', false, globalState);
        expect(
          yield* copilotRouteUnavailableReason('gemini31p', globalState),
        ).toBeUndefined();
      }),
  );

  it.effect('replaces route state after invalidation', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => installModels(GEMINI_PRO));
      yield* withProcessServices(testRuntime(), refreshRuntimeModelRegistry());
      expect(copilotRouteForModel('gemini31p')).toBeDefined();

      invalidateRuntimeModelRegistry();
      expect(copilotRouteForModel('gemini31p')).toBeDefined();
      yield* Effect.promise(() => installModels());
      yield* withProcessServices(testRuntime(), refreshRuntimeModelRegistry());

      expect(copilotRouteForModel('gemini31p')).toBeUndefined();
    }),
  );

  it.effect(
    'discards a discovery that an invalidation superseded mid-flight',
    () =>
      Effect.gen(function* () {
        const discovery = createDeferred<readonly LanguageModelInfo[]>();
        yield* Effect.promise(() =>
          installPlatform(
            {},
            {
              languageModel: {
                ...languageModelPort([]),
                selectModels: () => Effect.promise(() => discovery.promise),
              },
            },
          ),
        );

        const inFlight = yield* Effect.forkChild(
          withProcessServices(testRuntime(), refreshRuntimeModelRegistry()),
          { startImmediately: true },
        );
        invalidateRuntimeModelRegistry();
        discovery.resolve([GEMINI_PRO]);
        yield* Fiber.join(inFlight);

        // The superseded result must not land, and the registry must still be
        // stale enough that the next refresh re-probes the (new) port.
        expect(copilotRouteForModel('gemini31p')).toBeUndefined();

        const port = yield* Effect.promise(() => installModels(GPT_56));
        yield* withProcessServices(
          testRuntime(),
          refreshRuntimeModelRegistry(),
        );

        expect(port.selectModels).toHaveBeenCalledWith({ vendor: 'copilot' });
        expect(copilotRouteForModel('gpt56')).toBeDefined();
      }),
  );

  it.effect('does not make static models depend on native discovery', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({}, { languageModel: failingDiscoveryPort() }),
      );

      expect(
        yield* withProcessServices(
          testRuntime(),
          resolveRuntimeModelConfig('gpt55'),
        ),
      ).toBeDefined();
    }),
  );

  it.effect(
    'returns the last-known route catalogue when rediscovery fails',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installModels(GEMINI_PRO));
        yield* withProcessServices(
          testRuntime(),
          refreshRuntimeModelRegistry(),
        );

        invalidateRuntimeModelRegistry();
        yield* Effect.promise(() =>
          installPlatform({}, { languageModel: failingDiscoveryPort() }),
        );

        expect(
          (yield* withProcessServices(
            testRuntime(),
            discoveredCopilotRoutes(),
          )).get('gemini31p')?.access,
        ).toBe('allowed');
      }),
  );
});

describe('Copilot route in model pickers', () => {
  beforeEach(resetModelCaches);
  afterEach(resetModelCaches);

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
      const port = languageModelPort([GEMINI_PRO, GPT_56]);
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
    }),
  );
});
