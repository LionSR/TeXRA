import { Redacted } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiKeyEnvName,
  apiKeyExistsUncached,
  apiKeySecretName,
  configuredApiKeyProviders,
  getApiKey,
  hasUsableApiKey,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
  lookupApiKeyOrigin,
} from '@model/apiProviders';
import type { PlatformSecrets } from '@platform/secrets';
import { createDeferred } from '@test/support/asyncTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { UnsetApiKeyTool } from '@tools/setup/UnsetApiKeyTool';

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

/**
 * Install a fake host whose credential store is `secrets`, so `unset_api_key`
 * reads and writes the same store the assertions do.
 */
async function setupApiKeyToolPlatform(
  secrets: PlatformSecrets,
): Promise<void> {
  await installPlatform(
    {},
    {
      secrets,
      setup: {
        host: 'cli',
        signIn: async () => false,
        commands: {
          async invoke() {},
        },
      },
    },
  );
}

describe('API provider key caches', () => {
  beforeEach(() => {
    invalidateApiKeyCache();
  });

  afterEach(() => {
    invalidateApiKeyCache();
    vi.restoreAllMocks();
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

  it('propagates credential-store read failures to execution callers', async () => {
    const readError = new Error('credential store unavailable');
    const { secrets: backing } = createSecrets();
    const secrets: PlatformSecrets = {
      ...backing,
      get: vi.fn().mockRejectedValue(readError),
    };

    await expect(getApiKey(secrets, 'openai')).rejects.toBe(readError);
  });

  it('keeps concurrent and cached API keys bound to their credential stores', async () => {
    const firstRead = createDeferred<string | undefined>();
    const { secrets: backing } = createSecrets();
    const first: PlatformSecrets = {
      ...backing,
      get: vi.fn(() => firstRead.promise),
    };
    const { secrets: second } = createSecrets({
      [apiKeySecretName('openai')]: 'second-store-key',
    });
    const secondRead = vi.spyOn(second, 'get');

    const firstKey = getApiKey(first, 'openai');
    const secondKey = getApiKey(second, 'openai');
    firstRead.resolve('first-store-key');

    const [firstResolved, secondResolved] = await Promise.all([
      firstKey,
      secondKey,
    ]);
    // Keys leave the boundary sealed; unwrapping is explicit at every use.
    expect(String(firstResolved)).toBe('<redacted:openai>');
    expect(Redacted.value(firstResolved)).toBe('first-store-key');
    expect(Redacted.value(secondResolved)).toBe('second-store-key');
    await expect(getApiKey(first, 'openai').then(Redacted.value)).resolves.toBe(
      'first-store-key',
    );
    await expect(
      getApiKey(second, 'openai').then(Redacted.value),
    ).resolves.toBe('second-store-key');
    expect(first.get).toHaveBeenCalledTimes(1);
    expect(secondRead).toHaveBeenCalledTimes(1);
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
    const { secrets } = createSecrets({
      [apiKeySecretName('openai')]: 'sk-test',
    });
    await setupApiKeyToolPlatform(secrets);

    await expect(lookupApiKeyOrigin(secrets, 'openai')).resolves.toBe('secret');
    await new UnsetApiKeyTool().call({ provider: 'openai' });

    await expect(lookupApiKeyOrigin(secrets, 'openai')).resolves.toBe('none');
  });

  it('removes a stored key whose value can no longer be read', async () => {
    const { secrets, store } = createSecrets({
      [apiKeySecretName('openai')]: 'sk-test',
    });
    // The persisted entry is listed but unreadable: the removal path keys off
    // the stored key *names*, so it still has something to delete.
    vi.spyOn(secrets, 'get').mockResolvedValue(undefined);
    vi.spyOn(secrets, 'getStored').mockResolvedValue(undefined);
    await setupApiKeyToolPlatform(secrets);

    const result = await new UnsetApiKeyTool().call({ provider: 'openai' });

    expect(result.status).toBe('executed');
    expect(result.output).toContain('Removed stored API key');
    expect(store.has(apiKeySecretName('openai'))).toBe(false);
  });

  it('reports the canonical Kimi Code environment variable when unsetting', async () => {
    const { secrets } = createSecrets(
      {},
      { [apiKeyEnvName('kimiCode')]: 'from-env' },
    );
    await setupApiKeyToolPlatform(secrets);

    const result = await new UnsetApiKeyTool().call({ provider: 'kimiCode' });

    expect(result.status).toBe('executed');
    expect(result.output).toContain('KIMI_CODE_API_KEY');
    expect(result.output).not.toContain('KIMICODE_API_KEY');
  });
});
