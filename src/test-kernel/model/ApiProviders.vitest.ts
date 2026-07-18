// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  apiKeyEnvName,
  apiKeyExistsUncached,
  apiKeySecretName,
  hasUsableApiKey,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
  lookupApiKeyOrigin,
  type ApiProvider,
} from '@model/apiProviders';
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

function setupApiKeyToolPlatform(
  store: Map<string, string>,
  envProviders: ReadonlySet<ApiProvider> = new Set(),
): void {
  const platform: SetupPlatform = {
    host: 'cli',
    secrets: {
      providers: ['openai', 'kimiCode'],
      async deleteApiKey(provider) {
        store.delete(apiKeySecretName(provider));
      },
      async hasUsableApiKey(provider) {
        return (
          (store.get(apiKeySecretName(provider))?.trim().length ?? 0) > 0 ||
          envProviders.has(provider)
        );
      },
      async apiKeyOrigin(provider) {
        if (store.has(apiKeySecretName(provider))) return 'secret';
        return envProviders.has(provider) ? 'env' : 'none';
      },
      async storedApiKeyExists(provider) {
        return store.has(apiKeySecretName(provider));
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
    modelAccess: {
      async getChatGptSubscriptionStatus() {
        return { signedIn: false, enabled: false };
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

  it('uses the documented Kimi Code environment variable', () => {
    expect(apiKeyEnvName('kimiCode')).toBe('KIMI_CODE_API_KEY');
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

  it('falls through blank stored values to a usable environment key', async () => {
    const { secrets } = createSecrets(
      { [apiKeySecretName('openai')]: '   ' },
      { OPENAI_API_KEY: '  from-env  ' },
    );

    await expect(lookupApiKeyOrigin(secrets, 'openai')).resolves.toBe('env');
    await expect(hasUsableApiKey(secrets, 'openai')).resolves.toBe(true);
  });

  it('reports blank stored and environment values as absent', async () => {
    const { secrets } = createSecrets(
      { [apiKeySecretName('openai')]: '   ' },
      { OPENAI_API_KEY: '\t' },
    );

    await expect(lookupApiKeyOrigin(secrets, 'openai')).resolves.toBe('none');
    await expect(hasUsableApiKey(secrets, 'openai')).resolves.toBe(false);
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

  it('reports the canonical Kimi Code environment variable when unsetting', async () => {
    setupApiKeyToolPlatform(new Map(), new Set<ApiProvider>(['kimiCode']));

    const result = await new UnsetApiKeyTool().call({ provider: 'kimiCode' });

    expect(result.status).toBe('executed');
    expect(result.output).toContain('KIMI_CODE_API_KEY');
    expect(result.output).not.toContain('KIMICODE_API_KEY');
  });
});
