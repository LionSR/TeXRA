// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - auth
import { FREE_TIER, ULTRA_TIER, type UserTier } from '@auth/config';
import {
  ServerSideKeyService,
  type AuthProvider,
  type ServerSideKeyState,
} from '@auth/serverKeys/ServerSideKeyService';
import type { TierService } from '@auth/tier/TierService';

const USE_INCLUDED_ACCESS_KEY = 'texra.useIncludedModelAccess';

class MemoryState implements ServerSideKeyState {
  private readonly values = new Map<string, unknown>();

  constructor(initialValues: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initialValues)) {
      this.values.set(key, value);
    }
  }

  get<T>(key: string, defaultValue?: T): T {
    return this.values.has(key)
      ? (this.values.get(key) as T)
      : (defaultValue as T);
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function createTierService(
  options: { providers?: string[]; quotaExceeded?: boolean } = {},
): TierService {
  return {
    clearCache() {},
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
    getAllowedModels() {
      return [];
    },
    getAccessDescription() {
      return 'No included model access';
    },
    getExpirationDate() {
      return null;
    },
  } as unknown as TierService;
}

function createAuthProvider(
  options: {
    authenticated?: boolean;
    tier?: UserTier;
    accessToken?: string | null;
  } = {},
): AuthProvider {
  return {
    isAuthenticated: async () => options.authenticated ?? false,
    getUserTier: async (): Promise<UserTier> => options.tier ?? FREE_TIER,
    getAccessToken: async () => options.accessToken ?? null,
  };
}

describe('ServerSideKeyService quota fallback', () => {
  it('does not repeat the quota auto-switch after manual re-enable', async () => {
    const state = new MemoryState({ [USE_INCLUDED_ACCESS_KEY]: true });
    const service = new ServerSideKeyService(
      'https://example.test',
      createAuthProvider({
        authenticated: true,
        tier: ULTRA_TIER,
        accessToken: 'token',
      }),
      createTierService({
        providers: ['openai'],
        quotaExceeded: true,
      }),
    );

    service.initialize({ state });

    expect(await service.canUseServerSideKeys()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getUseIncludedModelAccess()).toBe(false);
    expect(service.wasQuotaAutoSwitched()).toBe(true);

    await service.setUseIncludedModelAccess(true);

    expect(service.getUseIncludedModelAccess()).toBe(true);
    expect(service.wasQuotaAutoSwitched()).toBe(false);
    expect(await service.canUseServerSideKeys()).toBe(true);
    expect(service.getUseIncludedModelAccess()).toBe(true);
  });
});
