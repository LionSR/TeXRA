import { beforeEach, describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  CODEX_SESSION_SECRET_KEY,
  resetCodexCoordinator,
  type CodexSession,
} from '@auth/codex';
import {
  ServerSideKeyService,
  setServerSideKeyService,
} from '@auth/serverKeys';
import { installTexraModelAccess } from '@controllers/modelAccess/installTexraModelAccess';
import {
  computeModelOptionsData,
  getModelUnavailableReason,
  invalidateModelOptionsCache,
  type ModelOptionsAccess,
  type ModelOptionsServerAccess,
} from '@model/computeModelOptions';
import {
  CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW,
  isCodexSubscriptionEligible,
} from '@model/providerCapabilities';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import type { ModelOptionData } from '@shared/schemas';
import { FAST_FIRST_RESPONSE_HINT } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeSecrets } from '@test/support/FakePlatform';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';

interface ServerAccessOptions {
  useIncludedAccess: boolean;
  readonly authenticated?: boolean;
  readonly canUseServerSideKeys?: boolean;
  readonly canUseModelSync?: boolean;
  readonly relayQuotaExceeded?: boolean;
  readonly quotaAutoSwitched?: boolean;
  readonly autoSwitchDuringAccessCheck?: boolean;
  readonly onAccessCheck?: () => void;
}

function createServerSideKeyService(
  options: ServerAccessOptions,
): ModelOptionsServerAccess {
  return {
    canUseServerSideKeys: async () => {
      options.onAccessCheck?.();
      if (options.autoSwitchDuringAccessCheck) {
        options.useIncludedAccess = false;
      }
      return options.canUseServerSideKeys ?? false;
    },
    getUseIncludedModelAccess: () => options.useIncludedAccess,
    isAuthenticated: async () => options.authenticated ?? true,
    isRelayQuotaExceeded: () => options.relayQuotaExceeded ?? false,
    wasQuotaAutoSwitched: () => options.quotaAutoSwitched ?? false,
    isProviderOnServer: () => true,
    canUseModelSync: () => options.canUseModelSync ?? false,
  };
}

function installServerSideKeyService(options: ServerAccessOptions): void {
  setServerSideKeyService(
    createServerSideKeyService(options) as unknown as ServerSideKeyService,
  );
}

function createModelOptionsAccess(
  options: ServerAccessOptions,
  secrets: Record<string, string> = {
    [apiKeySecretName('openai')]: 'sk-openai',
  },
): ModelOptionsAccess {
  return {
    visibleModels: ['gpt55'],
    secrets: new FakeSecrets(secrets),
    useOpenRouter: false,
    serverSideKeyService: createServerSideKeyService(options),
  };
}

function codexSession(): CodexSession {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAtMs: Date.now() + 60_000,
    accountId: 'account-id',
  };
}

function codexSessionSecrets(): Record<string, string> {
  return { [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession()) };
}

function initSubscriptionPlatform(
  secrets: Record<string, string> = {},
  enabledModels: string[] = ['gpt55'],
): Promise<void> {
  return installPlatform({
    config: {
      'texra.chatgptCodex.preferSubscription': true,
    },
    globalState: { [GlobalStateKey.ENABLED_MODELS]: enabledModels },
    secrets,
  });
}

describe('computeModelOptionsData relay quota state', () => {
  setupPlatform({
    globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gpt55'] },
    secrets: {
      [apiKeySecretName('openai')]: 'sk-openai',
      [apiKeySecretName('deepseek')]: 'sk-deepseek',
    },
  });

  beforeEach(() => {
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
    resetCodexCoordinator();
    // The picker reads the app's account plane through the model layer's
    // seam; install the same provider the three hosts install.
    installTexraModelAccess();
  });

  it('shows relay quota exhaustion while included access remains selected', async () => {
    const access = createModelOptionsAccess({
      useIncludedAccess: true,
      relayQuotaExceeded: true,
      quotaAutoSwitched: false,
    });

    const [model] = await computeModelOptionsData(undefined, access);

    expect(model.availability).toBe('relay-quota-exhausted');
    expect(model.disabled).toBe(true);
  });

  it('preserves the quota label when access check auto-switches included access off', async () => {
    const access = createModelOptionsAccess({
      useIncludedAccess: true,
      relayQuotaExceeded: true,
      quotaAutoSwitched: true,
      autoSwitchDuringAccessCheck: true,
    });

    const [model] = await computeModelOptionsData(undefined, access);

    expect(model.availability).toBe('relay-quota-exhausted');
    expect(model.disabled).toBe(true);
  });

  it('uses a Kimi Code key independently of selected relay access', async () => {
    const access = createModelOptionsAccess(
      {
        useIncludedAccess: true,
        canUseServerSideKeys: true,
        relayQuotaExceeded: true,
        quotaAutoSwitched: true,
      },
      { [apiKeySecretName('kimiCode')]: 'sk-kimi-code' },
    );

    const [model] = await computeModelOptionsData(['kimiCoding'], access);

    expect(model).toMatchObject({
      provider: 'kimiCode',
      availability: 'provider-key',
      disabled: false,
    });
  });

  it('does not treat a Moonshot key as a Kimi Code credential', async () => {
    const access = createModelOptionsAccess(
      {
        useIncludedAccess: true,
        canUseServerSideKeys: true,
      },
      { [apiKeySecretName('moonshot')]: 'sk-moonshot' },
    );

    const [model] = await computeModelOptionsData(['kimiCoding'], access);
    const reason = await getModelUnavailableReason('kimiCoding', access);

    expect(model).toMatchObject({
      provider: 'kimiCode',
      availability: 'missing-key',
      disabled: true,
    });
    expect(reason).toBe(
      'Model "kimiCoding" requires your Kimi Code API key. Provide it to continue.',
    );
  });

  it('asks signed-out included-access users to sign in rather than to add a key', async () => {
    const access = createModelOptionsAccess(
      { useIncludedAccess: true, authenticated: false },
      {},
    );

    const [model] = await computeModelOptionsData(['gpt55'], access);
    const reason = await getModelUnavailableReason('gpt55', access);

    expect(model).toMatchObject({
      availability: 'included-login-required',
      availabilityLabel: 'Sign in required',
      requiresKey: false,
      disabled: true,
    });
    expect(reason).toBe(
      'Model "gpt55" is served by included access, which needs an account. Sign in, or provide a provider API key and switch to your own API keys.',
    );
  });

  it('keeps a personal key usable while included access is selected but signed out', async () => {
    const access = createModelOptionsAccess({
      useIncludedAccess: true,
      authenticated: false,
    });

    const [model] = await computeModelOptionsData(['gpt55'], access);

    expect(model).toMatchObject({
      availability: 'provider-key',
      disabled: false,
    });
  });

  it('reports a signed-in user without tier coverage as missing a key, not signed out', async () => {
    const access = createModelOptionsAccess(
      { useIncludedAccess: true, authenticated: true },
      {},
    );

    const [model] = await computeModelOptionsData(['gpt55'], access);

    expect(model.availability).toBe('missing-key');
  });

  it('labels models the registry no longer describes instead of shipping a bare row', async () => {
    const access = createModelOptionsAccess({ useIncludedAccess: false });

    const [model] = await computeModelOptionsData(['no-such-model'], access);

    expect(model).toMatchObject({
      value: 'no-such-model',
      label: 'no-such-model',
      availability: 'unknown-model',
      availabilityLabel: 'Unknown model',
      requiresKey: false,
      disabled: true,
    });
  });

  it('falls back to personal keys when included access is disabled without quota auto-switch', async () => {
    const access = createModelOptionsAccess({
      useIncludedAccess: false,
      relayQuotaExceeded: true,
      quotaAutoSwitched: false,
    });

    const [model] = await computeModelOptionsData(undefined, access);

    expect(model.availability).toBe('provider-key');
    expect(model.disabled).toBe(false);
  });

  it('does not treat non-API providers as personal API-key access', async () => {
    const access = createModelOptionsAccess({ useIncludedAccess: false });

    const [model] = await computeModelOptionsData(['copilot4o'], access);

    expect(model.availability).toBe('missing-key');
    expect(model.disabled).toBe(true);
  });

  it('marks retired models unavailable before included-access checks', async () => {
    const access = createModelOptionsAccess({
      useIncludedAccess: true,
      canUseServerSideKeys: true,
      canUseModelSync: true,
    });

    const [model] = await computeModelOptionsData(['haiku3'], access);
    const reason = await getModelUnavailableReason('haiku3', access);

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

  it('does not tell users to configure API keys for keyless providers', async () => {
    const access = createModelOptionsAccess({ useIncludedAccess: false });

    const reason = await getModelUnavailableReason('copilot4o', access);

    expect(reason).toBe(
      'Model "copilot4o" is provided by Copilot, which does not use provider API keys. Use a host that supports Copilot models or choose another model.',
    );
  });

  it('does not disable API-key access when ChatGPT subscription is preferred but signed out', async () => {
    await initSubscriptionPlatform();
    const access = createModelOptionsAccess({ useIncludedAccess: false });

    const [model] = await computeModelOptionsData(['gpt55'], access);

    expect(model.availability).toBe('provider-key');
    expect(model.disabled).toBe(false);
  });

  it('does not advertise GPT-5.6 Pro through ChatGPT subscription', async () => {
    await installPlatform({
      config: {
        'texra.chatgptCodex.preferSubscription': true,
      },
      secrets: codexSessionSecrets(),
    });
    const access = createModelOptionsAccess({ useIncludedAccess: false }, {});

    const [model] = await computeModelOptionsData(['gpt56pro'], access);

    expect(MODEL_CONFIGS.gpt56pro.codexSubscription).not.toBe(true);
    expect(model).toMatchObject({
      availability: 'missing-key',
      disabled: true,
      requiresKey: true,
    });
  });

  it('marks GPT-5.6 Pro unavailable through OpenRouter', async () => {
    const access = {
      ...createModelOptionsAccess({ useIncludedAccess: false }),
      useOpenRouter: true,
    };

    const [model] = await computeModelOptionsData(['gpt56pro'], access);
    const reason = await getModelUnavailableReason('gpt56pro', access);

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
    const access = {
      ...createModelOptionsAccess({ useIncludedAccess: false }, {}),
      useOpenRouter: true,
    };

    const [model] = await computeModelOptionsData(['gpt55'], access);
    const reason = await getModelUnavailableReason('gpt55', access);

    expect(model).toMatchObject({
      availability: 'missing-key',
      disabled: true,
      requiresKey: true,
    });
    expect(reason).toBe('Model "gpt55" requires an OpenRouter API key.');
  });

  it('enables eligible OpenAI models from ChatGPT sign-in without an API key', async () => {
    await initSubscriptionPlatform(codexSessionSecrets());
    const access = createModelOptionsAccess(
      {
        useIncludedAccess: true,
        canUseServerSideKeys: true,
        canUseModelSync: true,
        relayQuotaExceeded: true,
        quotaAutoSwitched: false,
      },
      {},
    );

    const [model] = await computeModelOptionsData(['gpt55'], access);

    expect(model.availability).toBe('subscription-access');
    expect(model.context).toBe(
      `${Math.round(CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW / 1000)}K`,
    );
    expect(model.cost).toBe('$0.000/$0.000');
    expect(model.hint).not.toContain(FAST_FIRST_RESPONSE_HINT);
    expect(model.disabled).toBe(false);
  });

  it('automatically lists every active model served by ChatGPT', async () => {
    await initSubscriptionPlatform(codexSessionSecrets(), ['gemini31p']);
    const access = {
      ...createModelOptionsAccess({ useIncludedAccess: false }, {}),
      visibleModels: ['gemini31p'],
    };

    const models = await computeModelOptionsData(undefined, access);
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
    await initSubscriptionPlatform(codexSessionSecrets());
    const access = createModelOptionsAccess({ useIncludedAccess: false });

    const [model] = await computeModelOptionsData(['gpt55'], access);

    expect(model.availability).toBe('subscription-access');
  });

  it('does not reuse cached provider keys for injected access', async () => {
    installServerSideKeyService({ useIncludedAccess: false });
    await computeModelOptionsData(['deepseekproT']);

    const access = createModelOptionsAccess({ useIncludedAccess: false }, {});

    const [model] = await computeModelOptionsData(['deepseekproT'], access);

    expect(model.availability).toBe('missing-key');
    expect(model.disabled).toBe(true);
  });

  it('caches explicit model-list availability until invalidated', async () => {
    let accessChecks = 0;
    installServerSideKeyService({
      useIncludedAccess: false,
      onAccessCheck: () => {
        accessChecks += 1;
      },
    });

    const first = await computeModelOptionsData(['gpt55']);
    const second = await computeModelOptionsData(['gpt55']);

    expect(second).toBe(first);
    expect(accessChecks).toBe(1);

    invalidateModelOptionsCache();
    await computeModelOptionsData(['gpt55']);

    expect(accessChecks).toBe(2);
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
    const access = {
      ...createModelOptionsAccess(
        { useIncludedAccess: false },
        { [apiKeySecretName('openRouter')]: 'sk-openrouter' },
      ),
      useOpenRouter: true,
    };
    const [model] = await computeModelOptionsData(['kimi3'], access);

    expect(model).toMatchObject({
      provider: 'moonshot',
      routeLabel: 'Via OpenRouter',
      availability: 'openrouter-key',
      disabled: false,
    });
  });
});
