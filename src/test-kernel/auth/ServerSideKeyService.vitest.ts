// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { ULTRA_TIER } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { ServerSideKeyService } from '@auth/serverKeys/ServerSideKeyService';
import type { TierService } from '@auth/serverKeys/TierService';
import { appSignals } from '@eventBus/AppSignals';
import type { StateStore } from '@platform/interfaces';
import { createDeferred } from '@test/support/asyncTestUtils';
import { FakeStateStore } from '@test/support/FakePlatform';
import { delay } from '@utils/core';

const USE_INCLUDED_ACCESS_KEY = 'texra.useIncludedModelAccess';

interface FakeTierService {
  clearCacheCalls: number;
  getConfigCalls: number;
  service: TierService;
}

function createTierService(
  options: {
    providers?: string[];
    quotaExceeded?: boolean;
    configFailures?: number;
  } = {},
): FakeTierService {
  const config = {
    providers: options.providers ?? [],
    tiers: {
      free: { models: [] },
      Max: { models: [] },
      Ultra: { models: '*' as const },
    },
  };
  let configSnapshot: typeof config | null = null;
  let clearCacheCalls = 0;
  let getConfigCalls = 0;

  const service = {
    clearCache() {
      clearCacheCalls += 1;
    },
    async getConfig() {
      getConfigCalls += 1;
      if (getConfigCalls <= (options.configFailures ?? 0)) return null;
      configSnapshot = config;
      return configSnapshot;
    },
    getConfigSync() {
      return configSnapshot;
    },
    getProviders() {
      return configSnapshot?.providers ?? [];
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
    getExpirationDate() {
      return null;
    },
  } as unknown as TierService;

  return {
    get clearCacheCalls() {
      return clearCacheCalls;
    },
    get getConfigCalls() {
      return getConfigCalls;
    },
    service,
  };
}

function createService(
  tierService: TierService,
  state: StateStore | null = null,
  notifyIncludedModelAccessChanged?: (enabled: boolean) => void,
): ServerSideKeyService {
  return new ServerSideKeyService(
    'https://example.test',
    tierService,
    state,
    undefined,
    notifyIncludedModelAccessChanged,
  );
}

function mockAuthenticatedSupabase(): void {
  vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(true);
  vi.spyOn(SupabaseClient, 'getUserTier').mockResolvedValue(ULTRA_TIER);
}

function createIncludedAccessSetup(tierOptions: {
  quotaExceeded?: boolean;
  configFailures?: number;
}): {
  state: FakeStateStore;
  tier: FakeTierService;
  service: ServerSideKeyService;
} {
  const state = new FakeStateStore({ [USE_INCLUDED_ACCESS_KEY]: true });
  const tier = createTierService({ providers: ['openai'], ...tierOptions });
  const service = createService(tier.service, state);
  return { state, tier, service };
}

describe('ServerSideKeyService settings', () => {
  it('reads the included-access setting from host-provided state', () => {
    const tier = createTierService();
    const state = new FakeStateStore({ [USE_INCLUDED_ACCESS_KEY]: false });
    const service = createService(tier.service, state);

    expect(service.getUseIncludedModelAccess()).toBe(false);
  });

  it('keeps included access off when there is no host state store', () => {
    const tier = createTierService();
    const service = createService(tier.service);

    expect(service.getUseIncludedModelAccess()).toBe(false);
  });

  it('persists setting changes and fires change events', async () => {
    const tier = createTierService();
    const state = new FakeStateStore({ [USE_INCLUDED_ACCESS_KEY]: false });
    const changes: boolean[] = [];
    const service = createService(tier.service, state, (value) => {
      changes.push(value);
    });

    await service.setUseIncludedModelAccess(true);

    expect(state.get(USE_INCLUDED_ACCESS_KEY, false)).toBe(true);
    expect(changes).toEqual([true]);
    expect(tier.clearCacheCalls).toBe(1);
    expect(tier.getConfigCalls).toBe(0);
  });

  it('continues notifying after a listener fails', async () => {
    const tier = createTierService();
    const changes: boolean[] = [];
    const service = createService(tier.service, null, (value) => {
      appSignals.emit('includedModelAccessChanged', value);
    });
    const disposeFailing = appSignals.on('includedModelAccessChanged', () => {
      throw new Error('listener failed');
    });
    const disposeRecording = appSignals.on(
      'includedModelAccessChanged',
      (value) => {
        changes.push(value);
      },
    );

    try {
      // Stateless services start with included access off, so `true` is the
      // transition that fires here.
      await service.setUseIncludedModelAccess(true);
      expect(changes).toEqual([true]);
    } finally {
      disposeFailing();
      disposeRecording();
    }
  });
});

describe('ServerSideKeyService quota fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createQuotaExceededSetup(): {
    state: FakeStateStore;
    tier: FakeTierService;
    service: ServerSideKeyService;
  } {
    const setup = createIncludedAccessSetup({ quotaExceeded: true });
    mockAuthenticatedSupabase();
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');
    return setup;
  }

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

describe('ServerSideKeyService anonymous access cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refetches instead of serving a cached anonymous fetch', async () => {
    const { tier, service } = createIncludedAccessSetup({});
    mockAuthenticatedSupabase();
    const tokenSpy = vi
      .spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockResolvedValue(null);

    // Session refresh is dead: the fetch runs anonymously.
    expect(await service.canUseServerSideKeys()).toBe(true);
    expect(tier.getConfigCalls).toBe(1);

    // The cache is still TTL-valid, but it was populated anonymously — a
    // repeat check must refetch and pick up the now-valid token rather than
    // serving a snapshot that has no user spending data.
    tokenSpy.mockResolvedValue('token');
    expect(await service.canUseServerSideKeys()).toBe(true);
    expect(tier.getConfigCalls).toBe(2);

    // Once the cached fetch was authenticated, the TTL cache serves as before.
    expect(await service.canUseServerSideKeys()).toBe(true);
    expect(tier.getConfigCalls).toBe(2);
  });

  it('does not let a stale anonymous fetch erase authenticated access', async () => {
    const { service } = createIncludedAccessSetup({});
    const firstAuthentication = createDeferred<boolean>();
    vi.spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('token');
    vi.spyOn(SupabaseClient, 'isAuthenticated')
      .mockReturnValueOnce(firstAuthentication.promise)
      .mockResolvedValueOnce(true);
    vi.spyOn(SupabaseClient, 'getUserTier').mockResolvedValue(ULTRA_TIER);

    const anonymousFetch = service.canUseServerSideKeys();
    await Promise.resolve();
    const authenticatedFetch = service.canUseServerSideKeys();

    expect(await authenticatedFetch).toBe(true);
    expect(service.getUserTier()).toBe(ULTRA_TIER);
    expect(service.shouldUseServerSideKeysSync('openai')).toBe(true);

    firstAuthentication.resolve(false);
    expect(await anonymousFetch).toBe(false);

    expect(service.getUserTier()).toBe(ULTRA_TIER);
    expect(service.shouldUseServerSideKeysSync('openai')).toBe(true);
  });

  it('retries an authenticated Ultra check after a config fetch fails', async () => {
    const { tier, service } = createIncludedAccessSetup({ configFailures: 1 });
    mockAuthenticatedSupabase();
    vi.spyOn(SupabaseClient, 'getRelayAccessToken').mockResolvedValue('token');

    expect(await service.canUseServerSideKeys()).toBe(false);
    expect(await service.canUseServerSideKeys()).toBe(true);
    expect(tier.getConfigCalls).toBe(2);
  });
});
