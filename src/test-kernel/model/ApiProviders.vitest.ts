import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiKeyEnvName,
  apiKeyExistsUncached,
  apiKeySecretName,
  configuredApiKeyProviders,
  hasUsableApiKey,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
  lookupApiKeyOrigin,
  type ApiProvider,
} from '@model/apiProviders';
import type { PlatformSecrets } from '@platform/secrets';
import { createDeferred } from '@test/support/asyncTestUtils';
import { UnsetApiKeyTool } from '@tools/setup/UnsetApiKeyTool';
import { setSetupPlatform } from '@tools/setup/platform';

const setupSecretsMocks = vi.hoisted(() => ({
  deleteApiKey: vi.fn<(provider: ApiProvider) => Promise<void>>(),
  hasUsableApiKey: vi.fn<(provider: ApiProvider) => Promise<boolean>>(),
  storedApiKeyExists: vi.fn<(provider: ApiProvider) => Promise<boolean>>(),
}));

vi.mock('@tools/setup/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tools/setup/platform')>();
  return {
    ...actual,
    setupSecrets: {
      ...actual.setupSecrets,
      ...setupSecretsMocks,
    },
  };
});

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

function setupApiKeyToolPlatform(
  store: Map<string, string>,
  envProviders: ReadonlySet<ApiProvider> = new Set(),
): void {
  setupSecretsMocks.deleteApiKey.mockImplementation(async (provider) => {
    store.delete(apiKeySecretName(provider));
  });
  setupSecretsMocks.hasUsableApiKey.mockImplementation(
    async (provider) =>
      (store.get(apiKeySecretName(provider))?.trim().length ?? 0) > 0 ||
      envProviders.has(provider),
  );
  setupSecretsMocks.storedApiKeyExists.mockImplementation(async (provider) =>
    store.has(apiKeySecretName(provider)),
  );
  setSetupPlatform({
    host: 'cli',
    signIn: async () => false,
    commands: {
      async invoke() {},
    },
  });
}

describe('API provider key caches', () => {
  beforeEach(() => {
    invalidateApiKeyCache();
    for (const mock of Object.values(setupSecretsMocks)) mock.mockReset();
  });

  afterEach(() => {
    invalidateApiKeyCache();
    vi.restoreAllMocks();
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

  it('lists only providers with a configured key (secret or env)', async () => {
    const { secrets } = createSecrets(
      { [apiKeySecretName('openai')]: 'sk-test' },
      { MOONSHOT_API_KEY: 'from-env' },
    );

    await expect(configuredApiKeyProviders(secrets)).resolves.toEqual([
      'openai',
      'moonshot',
    ]);
  });

  it('reports no configured providers when every key is absent', async () => {
    const { secrets } = createSecrets();

    await expect(configuredApiKeyProviders(secrets)).resolves.toEqual([]);
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
    const { secrets: backing, store } = createSecrets();
    let reads = 0;
    const secrets: PlatformSecrets = {
      ...backing,
      async get(key) {
        reads += 1;
        if (reads === 1) return firstLookup.promise;
        return store.get(key);
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
