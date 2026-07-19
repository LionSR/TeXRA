// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Standard library imports

// Local imports - auth
import type { AuthServiceLogger } from '@auth/serviceLogger';
import {
  ServerSideKeyService,
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

interface FakeTierService {
  clearCacheCalls: number;
  getConfigCalls: number;
  service: TierService;
}

function createTierService(): FakeTierService {
  const fake = {
    clearCacheCalls: 0,
    getConfigCalls: 0,
    clearCache() {
      this.clearCacheCalls += 1;
    },
    async getConfig() {
      this.getConfigCalls += 1;
      return null;
    },
    getConfigSync() {
      return null;
    },
    getProviders() {
      return [];
    },
    isAccessExpired() {
      return false;
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
  logger?: AuthServiceLogger,
): ServerSideKeyService {
  return new ServerSideKeyService('https://example.test', tierService, logger);
}

describe('ServerSideKeyService', () => {
  it('reads the included-access setting from host-provided state', () => {
    const tier = createTierService();
    const state = new MemoryState({ [USE_INCLUDED_ACCESS_KEY]: false });
    const service = createService(tier.service);

    service.initialize({ state });

    assert.equal(service.getUseIncludedModelAccess(), false);
  });

  it('persists setting changes and fires change events', async () => {
    const tier = createTierService();
    const state = new MemoryState({ [USE_INCLUDED_ACCESS_KEY]: false });
    const service = createService(tier.service);
    const changes: boolean[] = [];

    service.initialize({ state });
    service.onDidChangeModelAccess((value) => {
      changes.push(value);
    });

    await service.setUseIncludedModelAccess(true);

    assert.equal(state.get(USE_INCLUDED_ACCESS_KEY, false), true);
    assert.deepEqual(changes, [true]);
    assert.equal(tier.clearCacheCalls, 1);
    assert.equal(tier.getConfigCalls, 0);
  });

  it('supports host subscription disposal without VS Code types', async () => {
    const tier = createTierService();
    const service = createService(tier.service);
    const subscriptions: Array<{ dispose(): void }> = [];
    const changes: boolean[] = [];

    service.initialize({ subscriptions });
    const listener = service.onDidChangeModelAccess((value) => {
      changes.push(value);
    });

    assert.equal(subscriptions.length, 3);

    listener.dispose();
    await service.setUseIncludedModelAccess(false);

    assert.deepEqual(changes, []);
  });

  it('continues dispatching when one listener throws', async () => {
    const tier = createTierService();
    const state = new MemoryState({ [USE_INCLUDED_ACCESS_KEY]: false });
    const errors: Array<{ channel: string; message: string }> = [];
    const logger: AuthServiceLogger = {
      info(channel, message) {
        void channel;
        void message;
      },
      error(channel, message) {
        errors.push({ channel, message });
      },
    };
    const service = createService(tier.service, logger);
    const changes: boolean[] = [];

    service.initialize({ state });
    service.onDidChangeModelAccess(() => {
      throw new Error('listener failed');
    });
    service.onDidChangeModelAccess((value) => {
      changes.push(value);
    });

    await assert.doesNotReject(() => service.setUseIncludedModelAccess(true));

    assert.deepEqual(changes, [true]);
    assert.equal(state.get(USE_INCLUDED_ACCESS_KEY, false), true);
    assert.deepEqual(errors, [
      {
        channel: 'ServerSideKeyService',
        message: 'Event listener failed: listener failed',
      },
    ]);
  });
});
