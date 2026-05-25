import { beforeEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import {
  ServerSideKeyService,
  setServerSideKeyService,
} from '@auth/serverKeys';
import { GlobalStateKey } from '@common/state/stateKeys';
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import {
  computeModelOptionsData,
  invalidateModelOptionsCache,
} from '@model/computeModelOptions';

function installServerSideKeyService(options: {
  useIncludedAccess: boolean;
  readonly relayQuotaExceeded: boolean;
  readonly quotaAutoSwitched: boolean;
  readonly autoSwitchDuringAccessCheck?: boolean;
}): void {
  setServerSideKeyService({
    canUseServerSideKeys: async () => {
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
  } as unknown as ServerSideKeyService);
}

describe('computeModelOptionsData relay quota state', () => {
  beforeEach(() => {
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
  });

  beforeEach(async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform({
        globalState: { [GlobalStateKey.ENABLED_MODELS]: ['gpt55'] },
        secrets: { [apiKeySecretName('openai')]: 'sk-openai' },
      }),
    );
  });

  it('shows relay quota exhaustion while included access remains selected', async () => {
    installServerSideKeyService({
      useIncludedAccess: true,
      relayQuotaExceeded: true,
      quotaAutoSwitched: false,
    });

    const [model] = await computeModelOptionsData();

    expect(model.availability).toBe('relay-quota-exhausted');
    expect(model.disabled).toBe(true);
  });

  it('preserves the quota label when access check auto-switches included access off', async () => {
    installServerSideKeyService({
      useIncludedAccess: true,
      relayQuotaExceeded: true,
      quotaAutoSwitched: true,
      autoSwitchDuringAccessCheck: true,
    });

    const [model] = await computeModelOptionsData();

    expect(model.availability).toBe('relay-quota-exhausted');
    expect(model.disabled).toBe(true);
  });

  it('falls back to personal keys after quota auto-switch disables included access', async () => {
    installServerSideKeyService({
      useIncludedAccess: false,
      relayQuotaExceeded: true,
      quotaAutoSwitched: true,
    });

    const [model] = await computeModelOptionsData();

    expect(model.availability).toBe('provider-key');
    expect(model.disabled).toBe(false);
  });
});
