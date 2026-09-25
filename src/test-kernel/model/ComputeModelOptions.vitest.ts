import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { Effect } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';

import { CODEX_SESSION_SECRET_KEY } from '@auth/codex/codexConstants';
import { installTexraAccountProbes } from '@controllers/modelAccess/installTexraAccountProbes';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import {
  modelOptionsFrom,
  modelUnavailableReasonFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import { decideModelRoute, OWN_KEY_ROUTE_FACTS } from '@model/modelRoute';
import { apiKeySecretName } from '@model/apiProviders';
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import { LanguageModel } from '@platform/languageModel';
import { SecretsFailed } from '@platform/secrets';
import {
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  isModelOptionAvailable,
  type ModelOptionData,
} from '@shared/schemas';
import { FAST_FIRST_RESPONSE_HINT } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { captureLogEntries } from '@test/support/logSinkCapture';
import {
  fakeHostLanguageModel,
  hostStores,
  installPlatform,
  setupPlatform,
} from '@test/support/setupPlatform';

const OPENAI_KEY_SECRETS = { [apiKeySecretName('openai')]: 'sk-openai' };

/**
 * The availability read over the installed fake host's language-model port:
 * the read's Copilot discovery yields the `LanguageModel` service, which the
 * bare `it.effect` runtime does not carry.
 */
const availabilityInputs = (
  ...args: Parameters<typeof readModelAvailabilityInputs>
) =>
  readModelAvailabilityInputs(...args).pipe(
    Effect.provide(LanguageModel.layer(fakeHostLanguageModel)),
  );

/**
 * Global state that counts the Copilot-preference reads, the one live state
 * read the route ladder makes per model.
 */
class CountingStateStore extends FakeStateStore {
  copilotPreferenceReads = 0;

  override get<T>(key: string, defaultValue?: T): Effect.Effect<T> {
    if (key === GlobalStateKey.COPILOT_ROUTE_MODELS) {
      this.copilotPreferenceReads += 1;
    }
    return super.get(key, defaultValue);
  }
}

/** A persisted selection with exactly `models` enabled. */
function onlyEnabled(models: readonly string[]) {
  return {
    enabledExtras: models,
    disabledDefaults: DEFAULT_MODELS.filter((model) => !models.includes(model)),
  };
}

/**
 * Reinstall the fake platform mid-test with the access state the case needs,
 * then clear the two process-wide caches the picker reads through.
 */
async function installAccessPlatform(
  options: {
    secrets?: Record<string, string>;
    config?: Record<string, unknown>;
    enabledModels?: string[];
    useOpenRouter?: boolean;
  } = {},
): Promise<void> {
  await installPlatform({
    config: options.config,
    globalState: {
      [GlobalStateKey.MODEL_SELECTION]: onlyEnabled(
        options.enabledModels ?? ['gpt55'],
      ),
      ...(options.useOpenRouter === undefined
        ? {}
        : { [GlobalStateKey.USE_OPENROUTER]: options.useOpenRouter }),
    },
    secrets: options.secrets ?? OPENAI_KEY_SECRETS,
  });
  // Coordinators are keyed by the secret store, so the reinstalled host's
  // store is what the probes installed here read.
  installTexraAccountProbes(hostStores().secrets);
}

function codexSessionSecrets(): Record<string, string> {
  return {
    [CODEX_SESSION_SECRET_KEY]: JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAtMs: Date.now() + 60_000,
      accountId: 'account-id',
    }),
  };
}

const PREFER_CODEX_CONFIG = {
  'texra.chatgptCodex.preferSubscription': true,
};

/** The logger production installs, so entries reach the captured sink. */
const withDiagnostics = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.provide(self, effectDiagnosticsLayer('Trace'));

afterEach(() => {
  setLogSink(null);
});

describe('model catalogue direct-route key ownership', () => {
  it('assigns every servable direct route to an API-key provider', () => {
    for (const [modelId, config] of Object.entries(MODEL_CONFIGS)) {
      if (config.retired) continue;
      const route = decideModelRoute(config, OWN_KEY_ROUTE_FACTS);
      if (route.kind === 'openrouter' || route.kind === 'copilot') continue;

      expect(
        route.kind,
        `${modelId} (${config.provider}) is servable without OpenRouter but has no direct API-key owner`,
      ).not.toBe('no-api-key');
    }
  });
});

/** The port's own failure for a credential store that cannot be read. */
function unreadableStore(cause: Error): SecretsFailed {
  return new SecretsFailed({
    reason: 'io',
    operation: 'get',
    message: cause.message,
    cause,
  });
}

describe('model availability', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.MODEL_SELECTION]: onlyEnabled(['gpt55']) },
    secrets: OPENAI_KEY_SECRETS,
  });

  beforeEach(() => {
    // The picker reads the app's account plane through the model layer's
    // seam; install the same probes the three hosts install.
    installTexraAccountProbes(hostStores().secrets);
  });

  it.effect.each([
    { model: 'gpt56', override: undefined, expected: 'Default (Medium)' },
    { model: 'gpt56', override: 'low', expected: 'Low' },
    { model: 'kimi3', override: 'low', expected: 'Max (fixed)' },
    { model: 'sonnet45T', override: 'low', expected: 'Default' },
    { model: 'gpt4o', override: 'high', expected: undefined },
  ])(
    'includes the current reasoning setting for $model ($override)',
    ({ model, override, expected }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            globalState: {
              [GlobalStateKey.REASONING_LEVELS]:
                override === undefined ? {} : { [model]: override },
            },
            secrets: OPENAI_KEY_SECRETS,
          }),
        );

        const [option] = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), [model]),
        );

        expect(option.reasoning).toBe(expected);
      }),
  );

  it.effect('uses a Kimi Code key for the plan-exclusive model', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installAccessPlatform({
          secrets: { [apiKeySecretName('kimiCode')]: 'sk-kimi-code' },
        }),
      );

      const [model] = modelOptionsFrom(
        yield* availabilityInputs(hostStores(), ['kimiCoding']),
      );

      expect(model).toMatchObject({
        provider: 'kimiCode',
        availability: 'provider-key',
      });
    }),
  );

  it.effect('does not treat a Moonshot key as a Kimi Code credential', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installAccessPlatform({
          secrets: { [apiKeySecretName('moonshot')]: 'sk-moonshot' },
        }),
      );

      const [model] = modelOptionsFrom(
        yield* availabilityInputs(hostStores(), ['kimiCoding']),
      );
      const reason = modelUnavailableReasonFrom(
        yield* availabilityInputs(hostStores(), ['kimiCoding']),
        'kimiCoding',
      );

      expect(model).toMatchObject({
        provider: 'kimiCode',
        availability: 'missing-key',
      });
      expect(reason).toBe(
        'Model "kimiCoding" requires your Kimi Code API key. Provide it to continue.',
      );
    }),
  );

  it.effect('reports a model with no stored key as missing a key', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => installAccessPlatform({ secrets: {} }));

      const [model] = modelOptionsFrom(
        yield* availabilityInputs(hostStores(), ['gpt55']),
      );

      expect(model.availability).toBe('missing-key');
    }),
  );

  it.effect(
    'warns once per provider when the picker cannot read credentials',
    () =>
      Effect.gen(function* () {
        const readError = new Error('credential store unavailable');
        const secrets = new FakeSecrets();
        vi.spyOn(secrets, 'get').mockReturnValue(
          Effect.fail(unreadableStore(readError)),
        );
        yield* Effect.promise(() =>
          installPlatform(
            {
              globalState: {
                [GlobalStateKey.MODEL_SELECTION]: onlyEnabled(['gpt55']),
              },
            },
            { secrets },
          ),
        );
        const logs = captureLogEntries();

        const [gpt55, gpt56] = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['gpt55', 'gpt56']),
        );

        expect(gpt55.availability).toBe('missing-key');
        expect(gpt56.availability).toBe('missing-key');
        // The provider reads run concurrently, so the order is not fixed.
        expect(logs.at('WARN').map((entry) => entry.message)).toEqual(
          expect.arrayContaining(
            ['OpenAI', 'OpenRouter', 'Kimi Code'].map((name) =>
              expect.stringContaining(
                `Failed to read ${name} API key status; treating it as unavailable.`,
              ),
            ),
          ),
        );
        expect(logs.at('WARN')).toHaveLength(3);
      }).pipe(withDiagnostics),
  );

  it.effect(
    'reads no provider key for a model the route ladder settles without one, and routes each model once',
    () =>
      Effect.gen(function* () {
        // The key statuses are read once per provider the ladder actually
        // consults, so a row settled before the key step (retired, here) never
        // turns into an Anthropic read — and never into its warning. Each row is
        // also routed exactly once: the Copilot preference is a live state read
        // inside the ladder, and the verdict finishes the decision it produced
        // instead of running the ladder again over inputs that may have moved.
        const secrets = new FakeSecrets();
        vi.spyOn(secrets, 'get').mockReturnValue(
          Effect.fail(unreadableStore(new Error('unreadable store'))),
        );
        const globalState = new CountingStateStore({
          [GlobalStateKey.MODEL_SELECTION]: onlyEnabled(['gpt55']),
        });
        yield* Effect.promise(() =>
          installPlatform({}, { secrets, globalState }),
        );
        const logs = captureLogEntries();

        const rows = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['haiku3', 'haiku35']),
        );

        expect(rows.map((row) => row.availability)).toEqual([
          'retired',
          'retired',
        ]);
        // Only the two routing keys every call resolves up front.
        expect(logs.at('WARN')).toHaveLength(2);

        // Two models that do reach the Copilot branch: one preference read each.
        const keyed = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['gpt55', 'gpt56']),
        );

        expect(keyed).toHaveLength(2);
        expect(globalState.copilotPreferenceReads).toBe(2);
      }).pipe(withDiagnostics),
  );

  it.effect(
    'finishes the rows without a further host read once the inputs are in',
    () =>
      Effect.gen(function* () {
        // The seam callers now own: everything that touches a host happens in
        // `readModelAvailabilityInputs`, and both finishers are synchronous
        // functions of that value — no store is consulted a second time while
        // the rows are built, so a credential change mid-render cannot split
        // one computation across two views of the host.
        //
        // `gpt56-` is preferred through Copilot with no route discovered, which
        // is the case whose sentence used to be worded at finish time out of
        // the live preference and catalogue: it is the arm that can leak a host
        // read past this boundary, so it is the one the counting store watches.
        const secrets = new FakeSecrets(OPENAI_KEY_SECRETS);
        const secretReads = vi.spyOn(secrets, 'get');
        const globalState = new CountingStateStore({
          [GlobalStateKey.MODEL_SELECTION]: onlyEnabled(['gpt55']),
          [GlobalStateKey.COPILOT_ROUTE_MODELS]: ['gpt56-'],
        });
        yield* Effect.promise(() =>
          installPlatform({}, { secrets, globalState }),
        );

        const inputs = yield* availabilityInputs(hostStores(), [
          'gpt55',
          'gpt56-',
        ]);
        const readsAfterInputs = secretReads.mock.calls.length;
        const preferenceReadsAfterInputs = globalState.copilotPreferenceReads;

        const rows = modelOptionsFrom(inputs);
        const available = modelUnavailableReasonFrom(inputs, 'gpt55');
        const copilot = modelUnavailableReasonFrom(inputs, 'gpt56-');

        expect(rows.map((row) => row.availability)).toEqual([
          'provider-key',
          'copilot-unavailable',
        ]);
        expect(available).toBeNull();
        expect(copilot).toBe(
          'VS Code does not currently offer "gpt56-" through Copilot.',
        );
        expect(secretReads.mock.calls).toHaveLength(readsAfterInputs);
        expect(globalState.copilotPreferenceReads).toBe(
          preferenceReadsAfterInputs,
        );
      }),
  );

  it.effect(
    'labels models the registry no longer describes instead of shipping a bare row',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installAccessPlatform());

        const [model] = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['no-such-model']),
        );

        expect(model).toMatchObject({
          value: 'no-such-model',
          label: 'no-such-model',
          availability: 'unknown-model',
        });
      }),
  );

  it.effect('reports a stored personal key as provider-key access', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => installAccessPlatform());

      const [model] = modelOptionsFrom(yield* availabilityInputs(hostStores()));

      expect(model.availability).toBe('provider-key');
      expect(isModelOptionAvailable(model)).toBe(true);
    }),
  );

  it.effect('marks retired models unavailable', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => installAccessPlatform());

      const [model] = modelOptionsFrom(
        yield* availabilityInputs(hostStores(), ['haiku3']),
      );
      const reason = modelUnavailableReasonFrom(
        yield* availabilityInputs(hostStores(), ['haiku3']),
        'haiku3',
      );

      expect(model.availability).toBe('retired');
      expect(isModelOptionAvailable(model)).toBe(false);
      expect(reason).toBe(
        'Model "haiku3" is retired and no longer available from its provider. Choose an active model.',
      );
    }),
  );

  it.effect(
    'does not disable API-key access when ChatGPT subscription is preferred but signed out',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installAccessPlatform({ config: PREFER_CODEX_CONFIG }),
        );

        const [model] = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['gpt55']),
        );

        expect(model.availability).toBe('provider-key');
        expect(isModelOptionAvailable(model)).toBe(true);
      }),
  );

  it.effect('does not advertise GPT-5.6 Pro through ChatGPT subscription', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installAccessPlatform({
          config: PREFER_CODEX_CONFIG,
          secrets: codexSessionSecrets(),
        }),
      );

      const [model] = modelOptionsFrom(
        yield* availabilityInputs(hostStores(), ['gpt56pro']),
      );

      expect(MODEL_CONFIGS.gpt56pro.codexSubscription).not.toBe(true);
      expect(model).toMatchObject({
        availability: 'missing-key',
      });
    }),
  );

  it.effect('marks GPT-5.6 Pro unavailable through OpenRouter', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installAccessPlatform({ useOpenRouter: true }),
      );

      const [model] = modelOptionsFrom(
        yield* availabilityInputs(hostStores(), ['gpt56pro']),
      );
      const reason = modelUnavailableReasonFrom(
        yield* availabilityInputs(hostStores(), ['gpt56pro']),
        'gpt56pro',
      );

      expect(model).toMatchObject({
        availability: 'provider-unavailable',
      });
      expect(reason).toBe(
        'Model "gpt56pro" requires a provider request mode that OpenRouter does not support. Disable OpenRouter and use the provider API directly.',
      );
    }),
  );

  it.effect(
    'asks for an OpenRouter key, not the provider key, on the OpenRouter route',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installAccessPlatform({ secrets: {}, useOpenRouter: true }),
        );

        const [model] = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['gpt55']),
        );
        const reason = modelUnavailableReasonFrom(
          yield* availabilityInputs(hostStores(), ['gpt55']),
          'gpt55',
        );

        expect(model).toMatchObject({
          availability: 'missing-key',
        });
        expect(reason).toBe('Model "gpt55" requires an OpenRouter API key.');
      }),
  );

  it.effect(
    'does not offer an OpenRouter key while the OpenRouter toggle is off',
    () =>
      Effect.gen(function* () {
        // Dispatch with the toggle off asks the direct provider for its key, so
        // an OpenRouter key alone must not mark the row ready.
        yield* Effect.promise(() =>
          installAccessPlatform({
            secrets: { [apiKeySecretName('openRouter')]: 'sk-openrouter' },
            useOpenRouter: false,
          }),
        );

        const [model] = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['gemini31p']),
        );

        expect(model.availability).toBe('missing-key');
      }),
  );

  it.effect(
    'enables eligible OpenAI models from ChatGPT sign-in without an API key',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installAccessPlatform({
            config: PREFER_CODEX_CONFIG,
            secrets: codexSessionSecrets(),
          }),
        );

        const [model] = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['gpt55']),
        );

        expect(model.availability).toBe('subscription-access');
        expect(model.context).toBe(
          `${Math.round(
            (CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.defaultValue *
              CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.tokensPerUnit +
              MODEL_CONFIGS.gpt55.maxOutputTokens) /
              1000,
          )}K`,
        );
        expect(model.cost).toBe('$0.000/$0.000');
        expect(model.hint).not.toContain(FAST_FIRST_RESPONSE_HINT);
        expect(isModelOptionAvailable(model)).toBe(true);
      }),
  );

  it.effect('automatically lists every active model served by ChatGPT', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installAccessPlatform({
          config: PREFER_CODEX_CONFIG,
          secrets: codexSessionSecrets(),
          enabledModels: ['gemini31p'],
        }),
      );

      const models = modelOptionsFrom(yield* availabilityInputs(hostStores()));
      const expected: string[] = [];
      for (const [model, config] of Object.entries(MODEL_CONFIGS)) {
        if (
          !config.retired &&
          !config.deprecated &&
          decideModelRoute(config, {
            ...OWN_KEY_ROUTE_FACTS,
            chatgptSubscription: true,
          }).kind === 'chatgpt-subscription'
        ) {
          expected.push(model);
        }
      }

      expect(models.map((model) => model.value)).toEqual(
        expect.arrayContaining(expected),
      );
      for (const model of models.filter((entry) =>
        expected.includes(entry.value),
      )) {
        expect(model).toMatchObject({
          availability: 'subscription-access',
        });
      }
    }),
  );

  it.effect(
    'shows subscription access for a signed-in preferred subscription',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installAccessPlatform({
            config: PREFER_CODEX_CONFIG,
            secrets: { ...codexSessionSecrets(), ...OPENAI_KEY_SECRETS },
          }),
        );

        const [model] = modelOptionsFrom(
          yield* availabilityInputs(hostStores(), ['gpt55']),
        );

        expect(model.availability).toBe('subscription-access');
      }),
  );
});

describe('model availability Kimi Code routing (dual-backend kimi3)', () => {
  const kimi3Option = (
    globalState: Record<string, unknown>,
    secrets: Record<string, string>,
  ): Effect.Effect<ModelOptionData, Error> =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installPlatform({
          globalState: {
            [GlobalStateKey.MODEL_SELECTION]: onlyEnabled(['kimi3']),
            ...globalState,
          },
          secrets,
        }),
      );
      const [model] = modelOptionsFrom(
        yield* availabilityInputs(hostStores(), ['kimi3']),
      );
      return model;
    });

  it.effect.each([
    {
      name: 'routes to Moonshot by default (Prefer Kimi Code off)',
      globalState: {},
      secrets: {
        [apiKeySecretName('kimiCode')]: 'sk-kimi-code',
        [apiKeySecretName('moonshot')]: 'sk-moonshot',
      },
    },
    {
      name: 'stays on Moonshot when preferred but no Kimi Code key exists',
      globalState: { [GlobalStateKey.KIMI_CODE_PREFER]: true },
      secrets: {
        [apiKeySecretName('moonshot')]: 'sk-moonshot',
      },
    },
  ])('$name', ({ globalState, secrets }) =>
    Effect.gen(function* () {
      const model = yield* kimi3Option(globalState, secrets);
      expect(model).toMatchObject({
        provider: 'moonshot',
        routeLabel: 'Via Moonshot',
        availability: 'provider-key',
      });
    }),
  );

  it.effect(
    'routes to Kimi Code when preferred and a Kimi Code key is set',
    () =>
      Effect.gen(function* () {
        const model = yield* kimi3Option(
          { [GlobalStateKey.KIMI_CODE_PREFER]: true },
          { [apiKeySecretName('kimiCode')]: 'sk-kimi-code' },
        );
        // Picker must show the Kimi Code route the factory will actually take,
        // even with no Moonshot key present — with membership (zero) pricing and
        // the conservative tier context cap, not the open platform's 1M / paid rate.
        expect(model).toMatchObject({
          provider: 'kimiCode',
          routeLabel: 'Via Kimi Code',
          availability: 'provider-key',
          cost: '$0.000/$0.000',
          context: '262K',
        });
      }),
  );

  it.effect(
    'reports OpenRouter without changing the Kimi K3 registry identity',
    () =>
      Effect.gen(function* () {
        const model = yield* kimi3Option(
          { [GlobalStateKey.USE_OPENROUTER]: true },
          { [apiKeySecretName('openRouter')]: 'sk-openrouter' },
        );

        expect(model).toMatchObject({
          provider: 'moonshot',
          routeLabel: 'Via OpenRouter',
          availability: 'openrouter-key',
        });
      }),
  );
});
