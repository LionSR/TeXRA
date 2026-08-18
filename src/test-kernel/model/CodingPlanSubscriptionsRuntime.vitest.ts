// Third-party imports
import { ModelProvider } from 'llm-zoo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { resolveProxyEndpoint } from '@agent/modelHandlers/support/ProxyConfigResolver';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import {
  activeCodingPlanForModel,
  codingPlanSubscriptionRuntimes,
} from '@model/codingPlanSubscriptions';
import {
  includedModelAccess,
  setIncludedModelAccess,
} from '@model/includedModelAccess';
import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { setupPlatform } from '@test/support/setupPlatform';

describe('coding-plan subscription runtime', () => {
  let includedAccessEnabled = false;
  let includedAccessAvailable = false;
  let relayServesModel = false;

  setupPlatform({
    globalState: {
      [GlobalStateKey.GLM_CODING_PLAN]: true,
      [GlobalStateKey.KIMI_CODE_PREFER]: false,
      [GlobalStateKey.USE_OPENROUTER]: true,
    },
    secrets: { [apiKeySecretName('glm')]: 'glm-key' },
  });

  beforeEach(() => {
    includedAccessEnabled = false;
    includedAccessAvailable = false;
    relayServesModel = false;
    invalidateApiKeyCache();
    setIncludedModelAccess({
      ...includedModelAccess(),
      getUseIncludedModelAccess: () => includedAccessEnabled,
      canUseServerSideKeys: async () => includedAccessAvailable,
      shouldUseServerSideKeysSync: () => relayServesModel,
    });
  });

  afterEach(async () => {
    setIncludedModelAccess(null);
    await platform().globalState.update(GlobalStateKey.ENDPOINT_GLM, '');
  });

  it('freezes every runtime catalog entry', () => {
    expect(Object.isFrozen(codingPlanSubscriptionRuntimes)).toBe(true);
    expect(codingPlanSubscriptionRuntimes.every(Object.isFrozen)).toBe(true);
  });

  it('classifies only the resolved official GLM coding endpoint as plan usage', async () => {
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    await platform().globalState.update(GlobalStateKey.ENDPOINT_GLM, '');

    expect(
      resolveProxyEndpoint({
        route: 'direct',
        provider: ModelProvider.GLM,
        useOpenRouter: false,
      }),
    ).toMatchObject({ usageRoute: 'glm-coding-plan-subscription' });

    await platform().globalState.update(
      GlobalStateKey.ENDPOINT_GLM,
      'proxy.test/api/coding/paas/v4',
    );
    expect(
      resolveProxyEndpoint({
        route: 'direct',
        provider: ModelProvider.GLM,
        useOpenRouter: false,
      }),
    ).toEqual({ baseUrl: 'https://proxy.test/api/coding/paas/v4' });

    expect(
      resolveProxyEndpoint({
        route: 'direct',
        provider: ModelProvider.GLM,
        useOpenRouter: true,
      }),
    ).toEqual({ baseUrl: 'https://openrouter.ai/api/v1' });
  });

  it('does not report the GLM plan when included access serves the model', async () => {
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    await expect(activeCodingPlanForModel('glm52')).resolves.toMatchObject({
      descriptor: { id: 'glmCodingPlan' },
    });

    includedAccessEnabled = true;
    relayServesModel = true;
    includedAccessAvailable = true;

    await expect(activeCodingPlanForModel('glm52')).resolves.toBeUndefined();
  });

  it('does not report the GLM plan when included access rejects the model tier', async () => {
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    includedAccessEnabled = true;
    includedAccessAvailable = true;
    relayServesModel = false;

    await expect(activeCodingPlanForModel('glm52')).resolves.toBeUndefined();
  });

  it('reports the GLM plan when included access is disabled', async () => {
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    includedAccessEnabled = false;
    includedAccessAvailable = true;

    await expect(activeCodingPlanForModel('glm52')).resolves.toMatchObject({
      descriptor: { id: 'glmCodingPlan' },
    });
  });

  it('does not classify a custom coding-shaped GLM endpoint as plan usage', async () => {
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    await platform().globalState.update(
      GlobalStateKey.ENDPOINT_GLM,
      'proxy.test/api/coding/paas/v4',
    );

    await expect(activeCodingPlanForModel('glm52')).resolves.toBeUndefined();
  });

  it('restores Kimi preference without overwriting newer OpenRouter state', async () => {
    const kimi = codingPlanSubscriptionRuntimes.find(
      (runtime) => runtime.descriptor.id === 'kimiCode',
    );

    await kimi?.restoreEnabled(true);

    expect(
      platform().globalState.get(GlobalStateKey.KIMI_CODE_PREFER, false),
    ).toBe(true);
    expect(
      platform().globalState.get(GlobalStateKey.USE_OPENROUTER, false),
    ).toBe(true);
  });
});
