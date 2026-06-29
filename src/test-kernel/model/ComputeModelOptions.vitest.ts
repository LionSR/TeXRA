import { beforeEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
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
  computeModelOptionsData,
  invalidateModelOptionsCache,
  type ModelOptionsAccess,
  type ModelOptionsServerAccess,
} from '@model/computeModelOptions';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { AgentCategory } from '@shared/schemas/agent';

function createServerSideKeyService(options: {
  useIncludedAccess: boolean;
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
      return false;
    },
    getUseIncludedModelAccess: () => options.useIncludedAccess,
    isRelayQuotaExceeded: () => options.relayQuotaExceeded,
    wasQuotaAutoSwitched: () => options.quotaAutoSwitched,
    isProviderOnServer: () => true,
    canUseModelSync: () => false,
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
      set: async () => {},
      delete: async () => {},
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

describe('computeModelOptionsData relay quota state', () => {
  beforeEach(() => {
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
    resetCodexCoordinator();
  });

  beforeEach(async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform({
        globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gpt55'] },
        secrets: {
          [apiKeySecretName('openai')]: 'sk-openai',
          [apiKeySecretName('deepseek')]: 'sk-deepseek',
        },
      }),
    );
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

  it('does not disable API-key access when ChatGPT subscription is preferred but signed out', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform({
        config: {
          'texra.chatgptCodex.preferSubscription': true,
          'texra.chatgptCodex.subscriptionToolUseOnly': true,
        },
        globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gpt55'] },
      }),
    );
    const access = createModelOptionsAccess({
      useIncludedAccess: false,
      relayQuotaExceeded: false,
      quotaAutoSwitched: false,
    });

    const [model] = await computeModelOptionsData(['gpt55'], access);

    expect(model.availability).toBe('provider-key');
    expect(model.disabled).toBe(false);
  });

  it('shows subscription access only for tool-use availability when the scoped switch is on', async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform({
        config: {
          'texra.chatgptCodex.preferSubscription': true,
          'texra.chatgptCodex.subscriptionToolUseOnly': true,
        },
        globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gpt55'] },
        secrets: {
          [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession()),
        },
      }),
    );
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
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform({
        config: {
          'texra.chatgptCodex.preferSubscription': true,
          'texra.chatgptCodex.subscriptionToolUseOnly': true,
        },
        globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gpt55'] },
        secrets: {
          [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession()),
        },
      }),
    );
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
    const previousDeepseekKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
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
    } finally {
      if (previousDeepseekKey === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = previousDeepseekKey;
      }
    }
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
