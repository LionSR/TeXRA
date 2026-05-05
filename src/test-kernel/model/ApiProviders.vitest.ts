// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  apiKeySecretName,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
  lookupApiKeyOrigin,
} from '@model/apiProviders';
import { SetApiKeyTool } from '@tools/setup/SetApiKeyTool';
import { UnsetApiKeyTool } from '@tools/setup/UnsetApiKeyTool';
import { setSetupPlatform, type SetupPlatform } from '@tools/setup/platform';
import type { PlatformSecrets } from '@platform/secrets';

function createSecrets(initial: Record<string, string> = {}): {
  secrets: PlatformSecrets;
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    secrets: {
      async get(key) {
        return store.get(key);
      },
      async set(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setupApiKeyToolPlatform(store: Map<string, string>): void {
  function keyName(provider: string): string {
    if (provider !== 'openai')
      throw new Error(`Unexpected provider ${provider}`);
    return apiKeySecretName(provider);
  }

  const platform: SetupPlatform = {
    secrets: {
      providers: ['openai'],
      async setApiKey(provider, key) {
        store.set(keyName(provider), key);
      },
      async deleteApiKey(provider) {
        store.delete(keyName(provider));
      },
      async apiKeyExists(provider) {
        return store.has(keyName(provider));
      },
      async hasUsableApiKey(provider) {
        return (store.get(keyName(provider))?.trim().length ?? 0) > 0;
      },
      async storedApiKeyExists(provider) {
        return store.has(keyName(provider));
      },
      async anyApiKeyExists() {
        return store.size > 0;
      },
      async gitHubTokenExists() {
        return 'none';
      },
    },
    commands: {
      async invoke() {},
    },
    extensions: {
      isInstalled() {
        return false;
      },
      async install() {},
    },
    auth: {
      async getStatus() {
        return { authenticated: false };
      },
    },
    config: {
      get() {
        return undefined;
      },
      async update() {},
    },
    terminal: {
      async runCommand() {
        return { exitCode: 0, output: '', timedOut: false };
      },
    },
  };
  setSetupPlatform(platform);
}

describe('API provider key caches', () => {
  let hadOpenAiApiKey = false;
  let originalOpenAiApiKey: string | undefined;

  beforeEach(() => {
    hadOpenAiApiKey = Object.hasOwn(process.env, 'OPENAI_API_KEY');
    originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    invalidateApiKeyCache();
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    invalidateApiKeyCache();
    if (hadOpenAiApiKey && originalOpenAiApiKey !== undefined) {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('derives provider status from the canonical API-key origin cache', async () => {
    const { secrets } = createSecrets({
      [apiKeySecretName('openai')]: 'sk-test',
    });

    await expect(loadApiKeyStatusMap(secrets, ['openai'])).resolves.toEqual({
      openai: 'set',
    });

    invalidateApiKeyCache();
    const empty = createSecrets();
    process.env.OPENAI_API_KEY = 'from-env';

    await expect(
      loadApiKeyStatusMap(empty.secrets, ['openai']),
    ).resolves.toEqual({
      openai: 'env',
    });
  });

  it('set_api_key invalidates stale missing-key lookups', async () => {
    const { secrets, store } = createSecrets();
    setupApiKeyToolPlatform(store);

    await expect(lookupApiKeyOrigin(secrets, 'openai')).resolves.toBe('none');
    await new SetApiKeyTool().call({ provider: 'openai', key: 'sk-real-key' });

    await expect(lookupApiKeyOrigin(secrets, 'openai')).resolves.toBe('secret');
  });

  it('does not let in-flight stale lookups repopulate the cache after invalidation', async () => {
    const firstLookup = createDeferred<string | undefined>();
    const store = new Map<string, string>();
    let reads = 0;
    const secrets: PlatformSecrets = {
      async get(key) {
        reads += 1;
        if (reads === 1) return firstLookup.promise;
        return store.get(key);
      },
      async set(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
    };

    const staleLookup = lookupApiKeyOrigin(secrets, 'openai');
    await secrets.set(apiKeySecretName('openai'), 'sk-after-invalidate');
    invalidateApiKeyCache();
    firstLookup.resolve(undefined);

    await expect(staleLookup).resolves.toBe('none');
    await expect(lookupApiKeyOrigin(secrets, 'openai')).resolves.toBe('secret');
  });

  it('unset_api_key invalidates stale stored-key lookups', async () => {
    const { secrets, store } = createSecrets({
      [apiKeySecretName('openai')]: 'sk-test',
    });
    setupApiKeyToolPlatform(store);

    await expect(lookupApiKeyOrigin(secrets, 'openai')).resolves.toBe('secret');
    await new UnsetApiKeyTool().call({ provider: 'openai' });

    await expect(lookupApiKeyOrigin(secrets, 'openai')).resolves.toBe('none');
  });
});
