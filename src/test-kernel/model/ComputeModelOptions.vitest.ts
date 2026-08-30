import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { resetCodexCoordinator } from '@auth/codex';
import { CODEX_SESSION_SECRET_KEY } from '@auth/codex/codexConstants';
import { installTexraAccountProbes } from '@controllers/modelAccess/installTexraAccountProbes';
import * as logger from '@logger/logUtils';
import {
  computeModelOptionsData,
  getModelUnavailableReason,
  invalidateModelOptionsCache,
} from '@model/computeModelOptions';
import {
  resolveDirectModelApiKeyProvider,
  shouldRouteModelThroughOpenRouter,
} from '@model/openRouterRouting';
import {
  CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT,
  isCodexSubscriptionEligible,
} from '@model/providerCapabilities';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import type { ModelOptionData } from '@shared/schemas';
import { FAST_FIRST_RESPONSE_HINT } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeSecrets } from '@test/support/FakePlatform';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';

const OPENAI_KEY_SECRETS = { [apiKeySecretName('openai')]: 'sk-openai' };

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
      [GlobalStateKey.ENABLED_MODELS]: options.enabledModels ?? ['gpt55'],
      ...(options.useOpenRouter === undefined
        ? {}
        : { [GlobalStateKey.USE_OPENROUTER]: options.useOpenRouter }),
    },
    secrets: options.secrets ?? OPENAI_KEY_SECRETS,
  });
  invalidateApiKeyCache();
  invalidateModelOptionsCache();
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

describe('model catalogue direct-route key ownership', () => {
  it('assigns every servable direct route to an API-key provider', () => {
    for (const [modelId, config] of Object.entries(MODEL_CONFIGS)) {
      if (config.retired) continue;
      if (shouldRouteModelThroughOpenRouter(config, false)) continue;

      expect(
        resolveDirectModelApiKeyProvider(config),
        `${modelId} (${config.provider}) is servable without OpenRouter but has no direct API-key owner`,
      ).toBeDefined();
    }
  });
});

describe('computeModelOptionsData availability', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gpt55'] },
    secrets: OPENAI_KEY_SECRETS,
  });

  beforeEach(() => {
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
    resetCodexCoordinator();
    // The picker reads the app's account plane through the model layer's
    // seam; install the same probes the three hosts install.
    installTexraAccountProbes();
  });

  it('uses a Kimi Code key for the plan-exclusive model', async () => {
    await installAccessPlatform({
      secrets: { [apiKeySecretName('kimiCode')]: 'sk-kimi-code' },
    });

    const [model] = await computeModelOptionsData(['kimiCoding']);

    expect(model).toMatchObject({
      provider: 'kimiCode',
      availability: 'provider-key',
      disabled: false,
    });
  });

  it('does not treat a Moonshot key as a Kimi Code credential', async () => {
    await installAccessPlatform({
      secrets: { [apiKeySecretName('moonshot')]: 'sk-moonshot' },
    });

    const [model] = await computeModelOptionsData(['kimiCoding']);
    const reason = await getModelUnavailableReason('kimiCoding');

    expect(model).toMatchObject({
      provider: 'kimiCode',
      availability: 'missing-key',
      disabled: true,
    });
    expect(reason).toBe(
      'Model "kimiCoding" requires your Kimi Code API key. Provide it to continue.',
    );
  });

  it('reports a model with no stored key as missing a key', async () => {
    await installAccessPlatform({ secrets: {} });

    const [model] = await computeModelOptionsData(['gpt55']);

    expect(model.availability).toBe('missing-key');
  });

  it('warns once per provider when concurrent option contexts cannot read credentials', async () => {
    const readError = new Error('credential store unavailable');
    const secrets = new FakeSecrets();
    vi.spyOn(secrets, 'get').mockRejectedValue(readError);
    await installPlatform(
      {
        globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gpt55'] },
      },
      { secrets },
    );
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const [[gpt55], [gpt56]] = await Promise.all([
      computeModelOptionsData(['gpt55']),
      computeModelOptionsData(['gpt56']),
    ]);

    expect(gpt55.availability).toBe('missing-key');
    expect(gpt56.availability).toBe('missing-key');
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      'computeModelOptions',
      'Failed to read OpenAI API key status; treating it as unavailable.',
      { data: readError },
    );
    expect(warn).toHaveBeenCalledWith(
      'computeModelOptions',
      'Failed to read OpenRouter API key status; treating it as unavailable.',
      { data: readError },
    );
    expect(warn).toHaveBeenCalledWith(
      'computeModelOptions',
      'Failed to read Kimi Code API key status; treating it as unavailable.',
      { data: readError },
    );
    warn.mockRestore();
  });

  it('labels models the registry no longer describes instead of shipping a bare row', async () => {
    await installAccessPlatform();

    const [model] = await computeModelOptionsData(['no-such-model']);

    expect(model).toMatchObject({
      value: 'no-such-model',
      label: 'no-such-model',
      availability: 'unknown-model',
      availabilityLabel: 'Unknown model',
      requiresKey: false,
      disabled: true,
    });
  });

  it('reports a stored personal key as provider-key access', async () => {
    await installAccessPlatform();

    const [model] = await computeModelOptionsData(undefined);

    expect(model.availability).toBe('provider-key');
    expect(model.disabled).toBe(false);
  });

  it('marks retired models unavailable', async () => {
    await installAccessPlatform();

    const [model] = await computeModelOptionsData(['haiku3']);
    const reason = await getModelUnavailableReason('haiku3');

    expect(model).toMatchObject({
      availability: 'retired',
      availabilityLabel: 'Retired',
      disabled: true,
      requiresKey: false,
    });
    expect(reason).toBe(
      'Model "haiku3" is retired and no longer available from its provider. Choose an active model.',
    );
  });

  it('honors the catalogue retirement of the legacy Copilot model', async () => {
    await installAccessPlatform();

    const [model] = await computeModelOptionsData(['copilot4o']);
    const reason = await getModelUnavailableReason('copilot4o');

    expect(model).toMatchObject({
      availability: 'retired',
      availabilityLabel: 'Retired',
      disabled: true,
      requiresKey: false,
    });
    expect(reason).toBe(
      'Model "copilot4o" is retired and no longer available from its provider. Choose an active model.',
    );
  });

  it('does not disable API-key access when ChatGPT subscription is preferred but signed out', async () => {
    await installAccessPlatform({ config: PREFER_CODEX_CONFIG });

    const [model] = await computeModelOptionsData(['gpt55']);

    expect(model.availability).toBe('provider-key');
    expect(model.disabled).toBe(false);
  });

  it('does not advertise GPT-5.6 Pro through ChatGPT subscription', async () => {
    await installAccessPlatform({
      config: PREFER_CODEX_CONFIG,
      secrets: codexSessionSecrets(),
    });

    const [model] = await computeModelOptionsData(['gpt56pro']);

    expect(MODEL_CONFIGS.gpt56pro.codexSubscription).not.toBe(true);
    expect(model).toMatchObject({
      availability: 'missing-key',
      disabled: true,
      requiresKey: true,
    });
  });

  it('marks GPT-5.6 Pro unavailable through OpenRouter', async () => {
    await installAccessPlatform({ useOpenRouter: true });

    const [model] = await computeModelOptionsData(['gpt56pro']);
    const reason = await getModelUnavailableReason('gpt56pro');

    expect(model).toMatchObject({
      availability: 'provider-unavailable',
      availabilityLabel: 'Unavailable through OpenRouter',
      disabled: true,
      requiresKey: false,
    });
    expect(reason).toBe(
      'Model "gpt56pro" requires a provider request mode that OpenRouter does not support. Disable OpenRouter and use the provider API directly.',
    );
  });

  it('asks for an OpenRouter key, not the provider key, on the OpenRouter route', async () => {
    await installAccessPlatform({ secrets: {}, useOpenRouter: true });

    const [model] = await computeModelOptionsData(['gpt55']);
    const reason = await getModelUnavailableReason('gpt55');

    expect(model).toMatchObject({
      availability: 'missing-key',
      disabled: true,
      requiresKey: true,
    });
    expect(reason).toBe('Model "gpt55" requires an OpenRouter API key.');
  });

  it('enables eligible OpenAI models from ChatGPT sign-in without an API key', async () => {
    await installAccessPlatform({
      config: PREFER_CODEX_CONFIG,
      secrets: codexSessionSecrets(),
    });

    const [model] = await computeModelOptionsData(['gpt55']);

    expect(model.availability).toBe('subscription-access');
    expect(model.context).toBe(
      `${Math.round(
        (CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT +
          MODEL_CONFIGS.gpt55.maxOutputTokens) /
          1000,
      )}K`,
    );
    expect(model.cost).toBe('$0.000/$0.000');
    expect(model.hint).not.toContain(FAST_FIRST_RESPONSE_HINT);
    expect(model.disabled).toBe(false);
  });

  it('automatically lists every active model served by ChatGPT', async () => {
    await installAccessPlatform({
      config: PREFER_CODEX_CONFIG,
      secrets: codexSessionSecrets(),
      enabledModels: ['gemini31p'],
    });

    const models = await computeModelOptionsData(undefined);
    const expected = Object.entries(MODEL_CONFIGS)
      .filter(
        ([, config]) =>
          !config.retired &&
          !config.deprecated &&
          isCodexSubscriptionEligible(config),
      )
      .map(([model]) => model);

    expect(models.map((model) => model.value)).toEqual(
      expect.arrayContaining(expected),
    );
    for (const model of models.filter((entry) =>
      expected.includes(entry.value),
    )) {
      expect(model).toMatchObject({
        availability: 'subscription-access',
        disabled: false,
        requiresKey: false,
      });
    }
  });

  it('shows subscription access for a signed-in preferred subscription', async () => {
    await installAccessPlatform({
      config: PREFER_CODEX_CONFIG,
      secrets: { ...codexSessionSecrets(), ...OPENAI_KEY_SECRETS },
    });

    const [model] = await computeModelOptionsData(['gpt55']);

    expect(model.availability).toBe('subscription-access');
  });

  it('caches explicit model-list availability', async () => {
    const first = await computeModelOptionsData(['gpt55']);
    const second = await computeModelOptionsData(['gpt55']);

    expect(second).toBe(first);
  });
});

describe('computeModelOptionsData Kimi Code routing (dual-backend kimi3)', () => {
  beforeEach(() => {
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
  });

  async function kimi3Option(
    globalState: Record<string, unknown>,
    secrets: Record<string, string>,
  ): Promise<ModelOptionData> {
    await installPlatform({
      globalState: {
        [GlobalStateKey.ENABLED_MODELS]: ['kimi3'],
        ...globalState,
      },
      secrets,
    });
    const [model] = await computeModelOptionsData(['kimi3']);
    return model;
  }

  it.each([
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
  ])('$name', async ({ globalState, secrets }) => {
    const model = await kimi3Option(globalState, secrets);
    expect(model).toMatchObject({
      provider: 'moonshot',
      routeLabel: 'Via Moonshot',
      availability: 'provider-key',
      disabled: false,
    });
  });

  it('routes to Kimi Code when preferred and a Kimi Code key is set', async () => {
    const model = await kimi3Option(
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
      disabled: false,
      cost: '$0.000/$0.000',
      context: '262K',
    });
  });

  it('reports OpenRouter without changing the Kimi K3 registry identity', async () => {
    const model = await kimi3Option(
      { [GlobalStateKey.USE_OPENROUTER]: true },
      { [apiKeySecretName('openRouter')]: 'sk-openrouter' },
    );

    expect(model).toMatchObject({
      provider: 'moonshot',
      routeLabel: 'Via OpenRouter',
      availability: 'openrouter-key',
      disabled: false,
    });
  });
});
