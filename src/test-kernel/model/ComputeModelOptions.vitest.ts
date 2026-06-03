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
  readonly onAccessCheck?: () => void;
}): void {
  setServerSideKeyService({
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

  it('falls back to personal keys when included access is disabled without quota auto-switch', async () => {
    installServerSideKeyService({
      useIncludedAccess: false,
      relayQuotaExceeded: true,
      quotaAutoSwitched: false,
    });

    const [model] = await computeModelOptionsData();

    expect(model.availability).toBe('provider-key');
    expect(model.disabled).toBe(false);
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
