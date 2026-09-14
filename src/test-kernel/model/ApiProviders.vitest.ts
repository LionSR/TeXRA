import { it } from '@effect/vitest';
import { Effect, Fiber, Redacted } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

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
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
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
      set(key, value) {
        return Effect.sync(() => {
          store.set(key, value);
        });
      },
      delete(key) {
        return Effect.sync(() => {
          store.delete(key);
        });
      },
      listStoredKeys() {
        return Effect.sync(() => [...store.keys()]);
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

  it.effect(
    'derives provider status from the canonical API-key origin cache',
    () =>
      Effect.gen(function* () {
        const { secrets } = createSecrets({
          [apiKeySecretName('openai')]: 'sk-test',
        });

        expect(yield* loadApiKeyStatusMap(secrets, ['openai'])).toEqual({
          openai: 'set',
        });

        invalidateApiKeyCache();
        const empty = createSecrets({}, { OPENAI_API_KEY: 'from-env' });

        expect(yield* loadApiKeyStatusMap(empty.secrets, ['openai'])).toEqual({
          openai: 'env',
        });
      }),
  );

  it.effect('lists only providers with a configured key (secret or env)', () =>
    Effect.gen(function* () {
      const { secrets } = createSecrets(
        { [apiKeySecretName('openai')]: 'sk-test' },
        { MOONSHOT_API_KEY: 'from-env' },
      );

      expect(yield* configuredApiKeyProviders(secrets)).toEqual([
        'openai',
        'moonshot',
      ]);
    }),
  );

  it.effect('treats empty env keys as missing in uncached lookups', () =>
    Effect.gen(function* () {
      const { secrets } = createSecrets({}, { OPENAI_API_KEY: '' });

      expect(yield* apiKeyExistsUncached(secrets, 'openai')).toBe(false);
    }),
  );

  it.effect(
    'falls through blank stored values to a usable environment key',
    () =>
      Effect.gen(function* () {
        const { secrets } = createSecrets(
          { [apiKeySecretName('openai')]: '   ' },
          { OPENAI_API_KEY: '  from-env  ' },
        );

        expect(yield* lookupApiKeyOrigin(secrets, 'openai')).toBe('env');
        expect(yield* hasUsableApiKey(secrets, 'openai')).toBe(true);
      }),
  );

  it.effect('reports blank stored and environment values as absent', () =>
    Effect.gen(function* () {
      const { secrets } = createSecrets(
        { [apiKeySecretName('openai')]: '   ' },
        { OPENAI_API_KEY: '\t' },
      );

      expect(yield* lookupApiKeyOrigin(secrets, 'openai')).toBe('none');
      expect(yield* hasUsableApiKey(secrets, 'openai')).toBe(false);
    }),
  );

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

  it.effect(
    'does not let in-flight stale lookups repopulate the cache after invalidation',
    () =>
      Effect.gen(function* () {
        const firstLookup = createDeferred<string | undefined>();
        const firstLookupStarted = createDeferred();
        const { secrets: backing, store } = createSecrets();
        let reads = 0;
        const secrets: PlatformSecrets = {
          ...backing,
          async get(key) {
            reads += 1;
            if (reads === 1) {
              firstLookupStarted.resolve();
              return firstLookup.promise;
            }
            return store.get(key);
          },
        };

        const staleLookup = yield* Effect.forkChild(
          lookupApiKeyOrigin(secrets, 'openai'),
        );
        // The invalidation below must race a read that has actually started.
        yield* Effect.promise(() => firstLookupStarted.promise);
        yield* secrets.set(apiKeySecretName('openai'), 'sk-after-invalidate');
        invalidateApiKeyCache();
        firstLookup.resolve(undefined);

        expect(yield* Fiber.join(staleLookup)).toBe('none');
        expect(yield* lookupApiKeyOrigin(secrets, 'openai')).toBe('secret');
      }),
  );

  it.effect('unset_api_key invalidates stale stored-key lookups', () =>
    Effect.gen(function* () {
      const { secrets } = createSecrets({
        [apiKeySecretName('openai')]: 'sk-test',
      });
      yield* Effect.promise(() => setupApiKeyToolPlatform(secrets));

      expect(yield* lookupApiKeyOrigin(secrets, 'openai')).toBe('secret');
      yield* new UnsetApiKeyTool()
        .call({ provider: 'openai' })
        .pipe(Effect.provide(nativeToolTestLayer()));

      expect(yield* lookupApiKeyOrigin(secrets, 'openai')).toBe('none');
    }),
  );

  it.effect('removes a stored key whose value can no longer be read', () =>
    Effect.gen(function* () {
      const { secrets, store } = createSecrets({
        [apiKeySecretName('openai')]: 'sk-test',
      });
      // The persisted entry is listed but unreadable: the removal path keys off
      // the stored key *names*, so it still has something to delete.
      vi.spyOn(secrets, 'get').mockResolvedValue(undefined);
      vi.spyOn(secrets, 'getStored').mockResolvedValue(undefined);
      yield* Effect.promise(() => setupApiKeyToolPlatform(secrets));

      const result = yield* new UnsetApiKeyTool()
        .call({ provider: 'openai' })
        .pipe(Effect.provide(nativeToolTestLayer()));

      expect(result.status).toBe('executed');
      expect(result.output).toContain('Removed stored API key');
      expect(store.has(apiKeySecretName('openai'))).toBe(false);
    }),
  );

  it.effect(
    'reports the canonical Kimi Code environment variable when unsetting',
    () =>
      Effect.gen(function* () {
        const { secrets } = createSecrets(
          {},
          { [apiKeyEnvName('kimiCode')]: 'from-env' },
        );
        yield* Effect.promise(() => setupApiKeyToolPlatform(secrets));

        const result = yield* new UnsetApiKeyTool()
          .call({ provider: 'kimiCode' })
          .pipe(Effect.provide(nativeToolTestLayer()));

        expect(result.status).toBe('executed');
        expect(result.output).toContain('KIMI_CODE_API_KEY');
        expect(result.output).not.toContain('KIMICODE_API_KEY');
      }),
  );
});
