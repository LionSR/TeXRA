// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { ULTRA_TIER } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { ServerSideKeyService } from '@auth/serverKeys/ServerSideKeyService';
import type { TierService } from '@auth/serverKeys/TierService';
import { FakeStateStore } from '@test/support/FakePlatform';
import { delay } from '@utils/core';

const USE_INCLUDED_ACCESS_KEY = 'texra.useIncludedModelAccess';

interface FakeTierService {
  clearCacheCalls: number;
  service: TierService;
}

function createTierService(
  options: { providers?: string[]; quotaExceeded?: boolean } = {},
): FakeTierService {
  const fake = {
    clearCacheCalls: 0,
    clearCache() {
      this.clearCacheCalls += 1;
    },
    async getConfig() {
      return {
        providers: options.providers ?? [],
        tiers: {
          free: { models: [] },
          Max: { models: [] },
          Ultra: { models: '*' },
        },
      };
    },
    getConfigSync() {
      return {
        providers: options.providers ?? [],
        tiers: {
          free: { models: [] },
          Max: { models: [] },
          Ultra: { models: '*' },
        },
      };
    },
    getProviders() {
      return options.providers ?? [];
    },
    isAccessExpired() {
      return false;
    },
    isQuotaExceeded() {
      return options.quotaExceeded ?? false;
    },
    isModelAvailable() {
      return false;
    },
    getAccessDescription() {
      return 'No included model access';
    },
    getExpirationDate() {
      return null;
    },
  };

  return {
    get clearCacheCalls() {
      return fake.clearCacheCalls;
    },
    service: fake as unknown as TierService,
  };
}

function createQuotaExceededSetup(): {
  state: FakeStateStore;
  tier: FakeTierService;
  service: ServerSideKeyService;
} {
  const state = new FakeStateStore({ [USE_INCLUDED_ACCESS_KEY]: true });
  const tier = createTierService({
    providers: ['openai'],
    quotaExceeded: true,
  });
  vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(true);
  vi.spyOn(SupabaseClient, 'getUserTier').mockResolvedValue(ULTRA_TIER);
  vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');
  const service = new ServerSideKeyService(
    'https://example.test',
    tier.service,
    state,
  );

  return { state, tier, service };
}

describe('ServerSideKeyService quota fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not repeat the quota auto-switch after manual re-enable', async () => {
    const { service } = createQuotaExceededSetup();

    expect(await service.canUseServerSideKeys()).toBe(false);
    await delay(0);
    expect(service.getUseIncludedModelAccess()).toBe(false);
    expect(service.wasQuotaAutoSwitched()).toBe(true);
    expect(service.isRelayQuotaExceeded()).toBe(true);

    await service.setUseIncludedModelAccess(true);

    expect(service.getUseIncludedModelAccess()).toBe(true);
    expect(service.wasQuotaAutoSwitched()).toBe(false);
    expect(await service.canUseServerSideKeys()).toBe(true);
    expect(service.getUseIncludedModelAccess()).toBe(true);

    await service.setUseIncludedModelAccess(false);

    expect(service.getUseIncludedModelAccess()).toBe(false);
    expect(service.wasQuotaAutoSwitched()).toBe(false);
  });

  it('preserves the spending-status cache after quota auto-switch', async () => {
    const { tier, service } = createQuotaExceededSetup();

    expect(await service.canUseServerSideKeys()).toBe(false);
    expect(service.getUseIncludedModelAccess()).toBe(false);
    expect(service.wasQuotaAutoSwitched()).toBe(true);
    expect(tier.clearCacheCalls).toBe(0);

    expect(await service.canUseServerSideKeys()).toBe(false);
    expect(tier.clearCacheCalls).toBe(0);
  });
});
