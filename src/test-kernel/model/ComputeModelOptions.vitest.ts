import { it } from '@effect/vitest';
import { afterEach, describe, expect, vi } from 'vitest';
import { Effect } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  apiKeySecretName,
  decideModelRoute,
  isUnservedModel,
  OWN_KEY_ROUTE_FACTS,
  SecretsFailed,
} from '@texra-ai/llm';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { readModelOptions, type ModelOption } from '@model/computeModelOptions';
import { DEFAULT_MODELS } from '@shared/constants/defaultModels';
import { isModelOptionAvailable, type ModelOptionData } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { captureLogEntries } from '@test/support/logSinkCapture';
import {
  hostStores,
  installPlatform,
  setupPlatform,
} from '@test/support/setupPlatform';
import { modelOptionsFrom } from '@texra/model/modelOptions';
import { FAST_FIRST_RESPONSE_HINT } from '@texra/shared/model/modelPicker';

/** The secret a ChatGPT session persists under. */
const CODEX_SESSION_SECRET_KEY = 'auth.chatgpt-codex';

const GPT55 = 'openai/gpt-5.5-2026-04-23';
const GPT56 = 'openai/gpt-5.6-sol';
const KIMI3 = 'moonshot/kimi-k3';
const SONNET45 = 'anthropic/claude-sonnet-4-5';
const GPT4O = 'openai/gpt-4o-2024-11-20';
const KIMI_CODING = 'moonshot/kimi-for-coding';
const HAIKU3 = 'anthropic/claude-3-haiku-20240307';
const HAIKU35 = 'anthropic/claude-3-5-haiku-20241022';
const GPT56_PRO = 'openai/gpt-5.6-sol+pro';
const GEMINI31P = 'google/gemini-3.1-pro-preview';

const OPENAI_KEY_SECRETS = { [apiKeySecretName('openai')]: 'sk-openai' };

/** The reason `model`'s option gives for not running, or `null` when it can. */
const unavailableReasonOf = (
  options: readonly ModelOption[],
  model: string,
): string | null =>
  options.find((option) => option.model === model)?.unavailableReason ?? null;

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
  } = {},
): Promise<void> {
  await installPlatform({
    config: options.config,
    globalState: {
      [GlobalStateKey.MODEL_SELECTION]: onlyEnabled(
        options.enabledModels ?? [GPT55],
      ),
    },
    secrets: options.secrets ?? OPENAI_KEY_SECRETS,
  });
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
      if (isUnservedModel(config)) continue;
      const route = decideModelRoute(config, OWN_KEY_ROUTE_FACTS);

      expect(
        route.kind,
        `${modelId} (${config.provider}) is servable but has no direct API-key owner`,
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
    globalState: { [GlobalStateKey.MODEL_SELECTION]: onlyEnabled([GPT55]) },
    secrets: OPENAI_KEY_SECRETS,
  });

  it.effect.each([
    { model: GPT56, override: undefined, expected: 'Default (Medium)' },
    // Kimi K3 takes low, high and max: the default medium snaps up to high.
    { model: KIMI3, override: undefined, expected: 'Default (High)' },
    { model: SONNET45, override: 'low', expected: 'Default' },
    { model: GPT4O, override: 'high', expected: undefined },
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
          yield* readModelOptions(hostStores(), [model]),
        );

        expect(option.reasoning).toBe(expected);
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
        yield* readModelOptions(hostStores(), [KIMI_CODING]),
      );
      const reason = unavailableReasonOf(
        yield* readModelOptions(hostStores(), [KIMI_CODING]),
        KIMI_CODING,
      );

      expect(model).toMatchObject({
        provider: 'kimiCode',
        availability: 'missing-key',
      });
      expect(reason).toBe(
        'Model "moonshot/kimi-for-coding" requires your Kimi Code API key. Provide it to continue.',
      );
    }),
  );

  it.effect(
    'reports an unreadable key store as such and warns once per provider',
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
                [GlobalStateKey.MODEL_SELECTION]: onlyEnabled([GPT55]),
              },
            },
            { secrets },
          ),
        );
        const logs = captureLogEntries();

        const [gpt55, gpt56] = modelOptionsFrom(
          yield* readModelOptions(hostStores(), [GPT55, GPT56]),
        );

        // An unreadable store is not a missing key.
        expect(gpt55.availability).toBe('key-unreadable');
        expect(gpt56.availability).toBe('key-unreadable');
        // The provider reads run concurrently, so the order is not fixed.
        expect(logs.at('WARN').map((entry) => entry.message)).toEqual(
          expect.arrayContaining(
            ['OpenAI', 'Kimi Code'].map((name) =>
              expect.stringContaining(`Failed to read ${name} API key status`),
            ),
          ),
        );
        expect(logs.at('WARN')).toHaveLength(2);
      }).pipe(withDiagnostics),
  );

  it.effect(
    'reads no provider key for a model the route ladder settles without one',
    () =>
      Effect.gen(function* () {
        // The key statuses are read once per provider the ladder actually
        // consults, so a row settled before the key step (retired, here) never
        // turns into an Anthropic read — and never into its warning.
        const secrets = new FakeSecrets();
        vi.spyOn(secrets, 'get').mockReturnValue(
          Effect.fail(unreadableStore(new Error('unreadable store'))),
        );
        const globalState = new FakeStateStore({
          [GlobalStateKey.MODEL_SELECTION]: onlyEnabled([GPT55]),
        });
        yield* Effect.promise(() =>
          installPlatform({}, { secrets, globalState }),
        );
        const logs = captureLogEntries();

        const rows = modelOptionsFrom(
          yield* readModelOptions(hostStores(), [HAIKU3, HAIKU35]),
        );

        expect(rows.map((row) => row.availability)).toEqual([
          'retired',
          'retired',
        ]);
        // Only the Kimi Code routing key every call resolves up front.
        expect(logs.at('WARN')).toHaveLength(1);
      }).pipe(withDiagnostics),
  );

  it.effect(
    'labels models the registry no longer describes instead of shipping a bare row',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installAccessPlatform());

        const [model] = modelOptionsFrom(
          yield* readModelOptions(hostStores(), ['no-such-model']),
        );

        expect(model).toMatchObject({
          value: 'no-such-model',
          label: 'no-such-model',
          availability: 'unknown-model',
        });
      }),
  );

  it.effect('marks retired models unavailable', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => installAccessPlatform());

      const [model] = modelOptionsFrom(
        yield* readModelOptions(hostStores(), [HAIKU3]),
      );
      const reason = unavailableReasonOf(
        yield* readModelOptions(hostStores(), [HAIKU3]),
        HAIKU3,
      );

      expect(model.availability).toBe('retired');
      expect(isModelOptionAvailable(model)).toBe(false);
      expect(reason).toBe(
        'Model "anthropic/claude-3-haiku-20240307" is retired and no longer available from its provider. Choose an active model.',
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
          yield* readModelOptions(hostStores(), [GPT55]),
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
        yield* readModelOptions(hostStores(), [GPT56_PRO]),
      );

      expect(MODEL_CONFIGS['openai/gpt-5.6-sol'].modes).toContain('pro');
      expect(model).toMatchObject({
        availability: 'missing-key',
      });
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
          yield* readModelOptions(hostStores(), [GPT56]),
        );

        expect(model.availability).toBe('subscription-access');
        expect(model.context).toBe(
          `${Math.round(
            ((MODEL_CONFIGS[GPT56].codexSubscription?.contextWindow ?? 0) +
              MODEL_CONFIGS[GPT56].maxOutputTokens) /
              1000,
          )}K`,
        );
        expect(model.cost).toBe('$0.000/$0.000');
        expect(model.hint).not.toContain(FAST_FIRST_RESPONSE_HINT);
        expect(isModelOptionAvailable(model)).toBe(true);
      }),
  );

  it.effect(
    'shows the medium a ChatGPT-subscription run sends for a saved High',
    () =>
      Effect.gen(function* () {
        // The subscription carries low and medium only; the bind substitutes
        // a saved High, so the row and the levels offered say what runs send.
        yield* Effect.promise(() =>
          installPlatform({
            config: PREFER_CODEX_CONFIG,
            globalState: {
              [GlobalStateKey.MODEL_SELECTION]: onlyEnabled([GPT56]),
              [GlobalStateKey.REASONING_LEVELS]: { [GPT56]: 'high' },
            },
            secrets: codexSessionSecrets(),
          }),
        );

        const options = yield* readModelOptions(hostStores(), [GPT56]);
        const [row] = modelOptionsFrom(options);

        expect(row.reasoning).toBe('Medium (High unavailable)');
        expect(options[0]).toMatchObject({
          reasoning: {
            efforts: ['none', 'low', 'medium'],
            sent: { effort: 'medium' },
          },
        });
      }),
  );

  it.effect('automatically lists every active model served by ChatGPT', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        installAccessPlatform({
          config: PREFER_CODEX_CONFIG,
          secrets: codexSessionSecrets(),
          enabledModels: [GEMINI31P],
        }),
      );

      const models = modelOptionsFrom(yield* readModelOptions(hostStores()));
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
            [GlobalStateKey.MODEL_SELECTION]: onlyEnabled([KIMI3]),
            ...globalState,
          },
          secrets,
        }),
      );
      const [model] = modelOptionsFrom(
        yield* readModelOptions(hostStores(), [KIMI3]),
      );
      return model;
    });

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
});
