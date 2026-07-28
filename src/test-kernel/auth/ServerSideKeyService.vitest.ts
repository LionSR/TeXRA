// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { ULTRA_TIER } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import { ServerSideKeyService } from '@auth/serverKeys/ServerSideKeyService';
import type { TierService } from '@auth/serverKeys/TierService';
import { appSignals } from '@eventBus/AppSignals';
import type { StateStore } from '@platform/interfaces';
import { FakeStateStore } from '@test/support/FakePlatform';
import { delay } from '@utils/core';

const USE_INCLUDED_ACCESS_KEY = 'texra.useIncludedModelAccess';

interface FakeTierService {
  clearCacheCalls: number;
  getConfigCalls: number;
  service: TierService;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createTierService(
  options: { providers?: string[]; quotaExceeded?: boolean } = {},
): FakeTierService {
  const fake = {
    clearCacheCalls: 0,
    getConfigCalls: 0,
    clearCache() {
      this.clearCacheCalls += 1;
    },
    async getConfig() {
      this.getConfigCalls += 1;
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
    get getConfigCalls() {
      return fake.getConfigCalls;
    },
    service: fake as unknown as TierService,
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
    const state = new FakeStateStore({ [USE_INCLUDED_ACCESS_KEY]: true });
    const tier = createTierService({ providers: ['openai'] });
    vi.spyOn(SupabaseClient, 'isAuthenticated').mockResolvedValue(true);
    vi.spyOn(SupabaseClient, 'getUserTier').mockResolvedValue(ULTRA_TIER);
    const tokenSpy = vi
      .spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockResolvedValue(null);
    const service = createService(tier.service, state);

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
    const state = new FakeStateStore({ [USE_INCLUDED_ACCESS_KEY]: true });
    const tier = createTierService({ providers: ['openai'] });
    const firstAuthentication = deferred<boolean>();
    vi.spyOn(SupabaseClient, 'getRelayAccessToken')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('token');
    vi.spyOn(SupabaseClient, 'isAuthenticated')
      .mockReturnValueOnce(firstAuthentication.promise)
      .mockResolvedValueOnce(true);
    vi.spyOn(SupabaseClient, 'getUserTier').mockResolvedValue(ULTRA_TIER);
    const service = createService(tier.service, state);

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
});
