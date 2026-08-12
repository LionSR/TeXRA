import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import { setProviderEndpoint } from '@utils/config/providerConfig';

describe('coding-plan subscription runtime', () => {
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
    relayServesModel = false;
    invalidateApiKeyCache();
    setIncludedModelAccess({
      ...includedModelAccess(),
      canUseServerSideKeys: async () => relayServesModel,
      shouldUseServerSideKeysSync: () => relayServesModel,
    });
  });

  afterEach(async () => {
    setIncludedModelAccess(null);
    await setProviderEndpoint('glm', '');
  });

  it('does not report the GLM plan when included access serves the model', async () => {
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    await expect(activeCodingPlanForModel('glm52')).resolves.toMatchObject({
      descriptor: { id: 'glmCodingPlan' },
    });

    relayServesModel = true;

    await expect(activeCodingPlanForModel('glm52')).resolves.toBeUndefined();
  });

  it('does not classify a custom coding-shaped GLM endpoint as plan usage', async () => {
    await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
    await setProviderEndpoint('glm', 'proxy.test/api/coding/paas/v4');

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
