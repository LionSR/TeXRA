import { beforeEach, describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import {
  ServerSideKeyService,
  setServerSideKeyService,
} from '@auth/serverKeys';
import {
  CODEX_SESSION_SECRET_KEY,
  resetCodexCoordinator,
  type CodexSession,
} from '@auth/codex';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import {
  CODEX_DEFAULT_SUBSCRIPTION_CONTEXT_WINDOW,
  isCodexSubscriptionEligible,
} from '@model/providerCapabilities';
import {
  computeModelOptionsData,
  getModelUnavailableReason,
  invalidateModelOptionsCache,
  type ModelOptionsAccess,
  type ModelOptionsServerAccess,
} from '@model/computeModelOptions';
import { FAST_FIRST_RESPONSE_HINT } from '@shared/constants/fastModels';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { AgentCategory } from '@shared/schemas/agent';

function createServerSideKeyService(options: {
  useIncludedAccess: boolean;
  readonly canUseServerSideKeys?: boolean;
  readonly canUseModelSync?: boolean;
  readonly relayQuotaExceeded: boolean;
  readonly quotaAutoSwitched: boolean;
  readonly autoSwitchDuringAccessCheck?: boolean;
  readonly onAccessCheck?: () => void;
}): ModelOptionsServerAccess {
  return {
    canUseServerSideKeys: async () => {
      options.onAccessCheck?.();
      if (options.autoSwitchDuringAccessCheck) {
        options.useIncludedAccess = false;
      }
      return options.canUseServerSideKeys ?? false;
    },
    getUseIncludedModelAccess: () => options.useIncludedAccess,
    isRelayQuotaExceeded: () => options.relayQuotaExceeded,
    wasQuotaAutoSwitched: () => options.quotaAutoSwitched,
    isProviderOnServer: () => true,
    canUseModelSync: () => options.canUseModelSync ?? false,
  };
}

function installServerSideKeyService(
  options: Parameters<typeof createServerSideKeyService>[0],
): void {
  setServerSideKeyService(
    createServerSideKeyService(options) as unknown as ServerSideKeyService,
  );
}

function createModelOptionsAccess(
  options: Parameters<typeof createServerSideKeyService>[0],
  secrets: Record<string, string> = {
    [apiKeySecretName('openai')]: 'sk-openai',
  },
): ModelOptionsAccess {
  return {
    visibleModels: ['gpt55'],
    secrets: {
      get: async (key) => secrets[key],
      getStored: async (key) => secrets[key],
      set: async () => {},
      delete: async () => {},
      listStoredKeys: async () => Object.keys(secrets),
      getEnv: () => undefined,
    },
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

function initSubscriptionPlatform(
  secrets: Record<string, string> = {},
): Promise<void> {
  return installPlatform({
    config: {
      'texra.chatgptCodex.preferSubscription': true,
      'texra.chatgptCodex.subscriptionToolUseOnly': true,
    },
    globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gpt55'] },
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

    const [model] = await computeModelOptionsData(['kimiCodeCoding'], access);

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
        relayQuotaExceeded: false,
        quotaAutoSwitched: false,
      },
      { [apiKeySecretName('moonshot')]: 'sk-moonshot' },
    );

    const [model] = await computeModelOptionsData(['kimiCodeCoding'], access);
    const reason = await getModelUnavailableReason('kimiCodeCoding', access);

    expect(model).toMatchObject({
      provider: 'kimiCode',
      availability: 'missing-key',
      disabled: true,
    });
    expect(reason).toBe(
      'Model "kimiCodeCoding" requires your Kimi Code API key. Provide it to continue.',
    );
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
    const access = createModelOptionsAccess({
      useIncludedAccess: false,
      relayQuotaExceeded: false,
      quotaAutoSwitched: false,
    });

    const [model] = await computeModelOptionsData(['copilot4o'], access);

    expect(model.availability).toBe('missing-key');
    expect(model.disabled).toBe(true);
  });

  it('marks retired models unavailable before included-access checks', async () => {
    const access = createModelOptionsAccess({
      useIncludedAccess: true,
      canUseServerSideKeys: true,
      canUseModelSync: true,
      relayQuotaExceeded: false,
      quotaAutoSwitched: false,
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
    const access = createModelOptionsAccess({
      useIncludedAccess: false,
      relayQuotaExceeded: false,
      quotaAutoSwitched: false,
    });

    const reason = await getModelUnavailableReason('copilot4o', access);

    expect(reason).toBe(
      'Model "copilot4o" is provided by Copilot, which does not use provider API keys. Use a host that supports Copilot models or choose another model.',
    );
  });

  it('does not disable API-key access when ChatGPT subscription is preferred but signed out', async () => {
    await initSubscriptionPlatform();
    const access = createModelOptionsAccess({
      useIncludedAccess: false,
      relayQuotaExceeded: false,
      quotaAutoSwitched: false,
    });

    const [model] = await computeModelOptionsData(['gpt55'], access);

    expect(model.availability).toBe('provider-key');
    expect(model.disabled).toBe(false);
  });

  it('does not advertise GPT-5.6 Pro through ChatGPT subscription', async () => {
    await installPlatform({
      config: {
        'texra.chatgptCodex.preferSubscription': true,
      },
      secrets: {
        [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession()),
      },
    });
    const access = {
      ...createModelOptionsAccess(
        {
          useIncludedAccess: false,
          relayQuotaExceeded: false,
          quotaAutoSwitched: false,
        },
        {},
      ),
      agentCategory: AgentCategory.ToolUse,
    };

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
      ...createModelOptionsAccess({
        useIncludedAccess: false,
        relayQuotaExceeded: false,
        quotaAutoSwitched: false,
      }),
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

  it('enables eligible OpenAI models from ChatGPT sign-in without an API key', async () => {
    await installPlatform({
      config: {
        'texra.chatgptCodex.preferSubscription': true,
      },
      globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gpt55'] },
      secrets: {
        [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession()),
      },
    });
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
    await installPlatform({
      config: {
        'texra.chatgptCodex.preferSubscription': true,
      },
      globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gemini31p'] },
      secrets: {
        [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession()),
      },
    });
    const access = {
      ...createModelOptionsAccess(
        {
          useIncludedAccess: false,
          relayQuotaExceeded: false,
          quotaAutoSwitched: false,
        },
        {},
      ),
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

  it('shows subscription access only for tool-use availability when the scoped switch is on', async () => {
    await initSubscriptionPlatform({
      [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession()),
    });
    const access = createModelOptionsAccess({
      useIncludedAccess: false,
      relayQuotaExceeded: false,
      quotaAutoSwitched: false,
    });

    const [toolUseModel] = await computeModelOptionsData(['gpt55'], access, {
      agentCategory: AgentCategory.ToolUse,
    });
    const [workflowModel] = await computeModelOptionsData(['gpt55'], access, {
      agentCategory: AgentCategory.Workflow,
    });

    expect(toolUseModel.availability).toBe('subscription-access');
    expect(workflowModel.availability).toBe('provider-key');
  });

  it('does not advertise subscription access for untagged availability checks under the scoped switch', async () => {
    await initSubscriptionPlatform({
      [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession()),
    });
    const access = createModelOptionsAccess(
      {
        useIncludedAccess: false,
        relayQuotaExceeded: false,
        quotaAutoSwitched: false,
      },
      {},
    );

    const [model] = await computeModelOptionsData(['gpt55'], access);

    expect(model.availability).toBe('missing-key');
    expect(model.disabled).toBe(true);
  });

  it('does not reuse cached provider keys for injected access', async () => {
    installServerSideKeyService({
      useIncludedAccess: false,
      relayQuotaExceeded: false,
      quotaAutoSwitched: false,
    });
    await computeModelOptionsData(['deepseekproT']);

    const access = createModelOptionsAccess(
      {
        useIncludedAccess: false,
        relayQuotaExceeded: false,
        quotaAutoSwitched: false,
      },
      {},
    );

    const [model] = await computeModelOptionsData(['deepseekproT'], access);

    expect(model.availability).toBe('missing-key');
    expect(model.disabled).toBe(true);
  });

  it('caches explicit model-list availability until invalidated', async () => {
    let accessChecks = 0;
    installServerSideKeyService({
      useIncludedAccess: false,
      relayQuotaExceeded: false,
      quotaAutoSwitched: false,
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
