// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  apiKeyExistsUncached,
  apiKeySecretName,
  hasUsableApiKey,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
  lookupApiKeyOrigin,
} from '@model/apiProviders';
import { SetApiKeyTool } from '@tools/setup/SetApiKeyTool';
import { UnsetApiKeyTool } from '@tools/setup/UnsetApiKeyTool';
import { setSetupPlatform, type SetupPlatform } from '@tools/setup/platform';
import type { PlatformSecrets } from '@platform/secrets';

function createSecrets(
  initial: Record<string, string> = {},
  env: Record<string, string> = {},
): {
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
      async getStored(key) {
        return store.get(key);
      },
      async set(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
      async listStoredKeys() {
        return [...store.keys()];
      },
      getEnv(name) {
        return env[name];
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
      async anyUsableCredentialExists() {
        return store.size > 0;
      },
      async gitHubTokenExists() {
        return 'none';
      },
      async listStoredKeys() {
        return [...store.keys()] as readonly string[];
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
        return {
          authenticated: false,
          remoteAgentCatalogAvailable: false,
        };
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
  beforeEach(() => {
    invalidateApiKeyCache();
  });

  afterEach(() => {
    invalidateApiKeyCache();
  });

  it('derives provider status from the canonical API-key origin cache', async () => {
    const { secrets } = createSecrets({
      [apiKeySecretName('openai')]: 'sk-test',
    });

    await expect(loadApiKeyStatusMap(secrets, ['openai'])).resolves.toEqual({
      openai: 'set',
    });

    invalidateApiKeyCache();
    const empty = createSecrets({}, { OPENAI_API_KEY: 'from-env' });

    await expect(
      loadApiKeyStatusMap(empty.secrets, ['openai']),
    ).resolves.toEqual({
      openai: 'env',
    });
  });

  it('treats empty env keys as missing in uncached lookups', async () => {
    const { secrets } = createSecrets({}, { OPENAI_API_KEY: '' });

    await expect(apiKeyExistsUncached(secrets, 'openai')).resolves.toBe(false);
  });

  it('checks usable keys through the canonical resolver', async () => {
    const { secrets } = createSecrets(
      { [apiKeySecretName('openai')]: '   ' },
      { OPENAI_API_KEY: 'from-env' },
    );

    await expect(hasUsableApiKey(secrets, 'openai')).resolves.toBe(false);

    invalidateApiKeyCache();
    await secrets.delete(apiKeySecretName('openai'));

    await expect(hasUsableApiKey(secrets, 'openai')).resolves.toBe(true);
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
      async getStored(key) {
        return store.get(key);
      },
      async set(key, value) {
        store.set(key, value);
      },
      async delete(key) {
        store.delete(key);
      },
      async listStoredKeys() {
        return [...store.keys()];
      },
      getEnv() {
        return undefined;
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
