// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - auth
import { ServerSideKeyService } from '@auth/serverKeys/ServerSideKeyService';
import type { TierService } from '@auth/serverKeys/TierService';
import { appSignals } from '@eventBus/AppSignals';
import type { StateStore } from '@platform/interfaces';
import { FakeStateStore } from '@test/support/FakePlatform';

const USE_INCLUDED_ACCESS_KEY = 'texra.useIncludedModelAccess';

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

describe('ServerSideKeyService', () => {
  it('reads the included-access setting from host-provided state', () => {
    const tier = createTierService();
    const state = new FakeStateStore({ [USE_INCLUDED_ACCESS_KEY]: false });
    const service = createService(tier.service, state);

    assert.equal(service.getUseIncludedModelAccess(), false);
  });

  it('persists setting changes and fires change events', async () => {
    const tier = createTierService();
    const state = new FakeStateStore({ [USE_INCLUDED_ACCESS_KEY]: false });
    const changes: boolean[] = [];
    const service = createService(tier.service, state, (value) => {
      changes.push(value);
    });

    await service.setUseIncludedModelAccess(true);

    assert.equal(state.get(USE_INCLUDED_ACCESS_KEY, false), true);
    assert.deepEqual(changes, [true]);
    assert.equal(tier.clearCacheCalls, 1);
    assert.equal(tier.getConfigCalls, 0);
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
      await service.setUseIncludedModelAccess(false);
      assert.deepEqual(changes, [false]);
    } finally {
      disposeFailing();
      disposeRecording();
    }
  });
});
