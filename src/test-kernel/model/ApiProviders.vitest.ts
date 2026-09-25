import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Redacted } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { CliSecrets } from '@cli/runtime/cliSecrets';
import { onAppSignal } from '@eventBus/AppSignals';

import {
  apiKeySecretName,
  configuredApiKeyProviders,
  getApiKey,
  hasUsableApiKey,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
  lookupApiKeyOrigin,
  lookupApiKeyUncached,
} from '@model/apiProviders';
import { SecretsFailed, type PlatformSecrets } from '@platform/secrets';
import { apiKeyEnvName } from '@shared/constants/providers';
import { createDeferred } from '@test/support/asyncTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { withTempDirEffect } from '@test/support/tempDirPlatform';
import { withEnv } from '@test/support/testEnv';
import { UnsetApiKeyTool } from '@tools/setup/UnsetApiKeyTool';

function createSecrets(initial: Record<string, string> = {}): {
  secrets: PlatformSecrets;
  store: Map<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    secrets: {
      get(key) {
        return Effect.sync(() => store.get(key));
      },
      getStored(key) {
        return Effect.sync(() => store.get(key));
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
    },
  };
}

/**
 * Install a fake host whose credential store is `secrets`, so `unset_api_key`
 * reads and writes the same store the assertions do.
 */
async function setupApiKeyToolPlatform(
  secrets: PlatformSecrets,
  env: Record<string, string> = {},
): Promise<void> {
  await installPlatform(
    { env },
    {
      secrets,
      setup: {
        host: 'cli',
        signIn: () => Effect.succeed(false),
        commands: {
          invoke: () => Effect.void,
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
        const empty = createSecrets({});

        expect(
          yield* loadApiKeyStatusMap(empty.secrets, ['openai']).pipe(
            withEnv({ OPENAI_API_KEY: 'from-env' }),
          ),
        ).toEqual({
          openai: 'env',
        });
      }).pipe(withEnv({})),
  );

  it.effect('lists only providers with a configured key (secret or env)', () =>
    Effect.gen(function* () {
      const { secrets } = createSecrets({
        [apiKeySecretName('openai')]: 'sk-test',
      });

      expect(yield* configuredApiKeyProviders(secrets)).toEqual([
        'openai',
        'moonshot',
      ]);
    }).pipe(withEnv({ MOONSHOT_API_KEY: 'from-env' })),
  );

  it.effect('treats empty env keys as missing in uncached lookups', () =>
    Effect.gen(function* () {
      const { secrets } = createSecrets({});

      expect(yield* lookupApiKeyUncached(secrets, 'openai')).toBeUndefined();
    }).pipe(withEnv({ OPENAI_API_KEY: '' })),
  );

  it.effect(
    'falls through blank stored values to a usable environment key',
    () =>
      Effect.gen(function* () {
        const { secrets } = createSecrets({
          [apiKeySecretName('openai')]: '   ',
        });

        expect(yield* lookupApiKeyOrigin(secrets, 'openai')).toBe('env');
        expect(yield* hasUsableApiKey(secrets, 'openai')).toBe(true);
      }).pipe(withEnv({ OPENAI_API_KEY: '  from-env  ' })),
  );

  it.effect('reports blank stored and environment values as absent', () =>
    Effect.gen(function* () {
      const { secrets } = createSecrets({
        [apiKeySecretName('openai')]: '   ',
      });

      expect(yield* lookupApiKeyOrigin(secrets, 'openai')).toBe('none');
      expect(yield* hasUsableApiKey(secrets, 'openai')).toBe(false);
    }).pipe(withEnv({ OPENAI_API_KEY: '\t' })),
  );

  it.effect(
    'propagates credential-store read failures to execution callers',
    () =>
      Effect.gen(function* () {
        const readFailure = new SecretsFailed({
          reason: 'io',
          operation: 'get',
          message: 'credential store unavailable',
        });
        const { secrets: backing } = createSecrets();
        const secrets: PlatformSecrets = {
          ...backing,
          get: vi.fn(() => Effect.fail(readFailure)),
        };

        expect(yield* Effect.flip(getApiKey(secrets, 'openai'))).toBe(
          readFailure,
        );
      }).pipe(withEnv({})),
  );

  it.effect(
    'keeps concurrent and cached API keys bound to their credential stores',
    () =>
      Effect.gen(function* () {
        const firstRead = createDeferred<string | undefined>();
        const { secrets: backing } = createSecrets();
        const first: PlatformSecrets = {
          ...backing,
          get: vi.fn(() => Effect.promise(() => firstRead.promise)),
        };
        const { secrets: second } = createSecrets({
          [apiKeySecretName('openai')]: 'second-store-key',
        });
        const secondRead = vi.spyOn(second, 'get');

        const firstKey = yield* Effect.forkChild(getApiKey(first, 'openai'));
        const secondKey = yield* Effect.forkChild(getApiKey(second, 'openai'));
        firstRead.resolve('first-store-key');

        const firstResolved = yield* Fiber.join(firstKey);
        const secondResolved = yield* Fiber.join(secondKey);
        // Keys leave the boundary sealed; unwrapping is explicit at every use.
        expect(String(firstResolved)).toBe('<redacted:openai>');
        expect(Redacted.value(firstResolved)).toBe('first-store-key');
        expect(Redacted.value(secondResolved)).toBe('second-store-key');
        expect(Redacted.value(yield* getApiKey(first, 'openai'))).toBe(
          'first-store-key',
        );
        expect(Redacted.value(yield* getApiKey(second, 'openai'))).toBe(
          'second-store-key',
        );
        expect(first.get).toHaveBeenCalledTimes(1);
        expect(secondRead).toHaveBeenCalledTimes(1);
      }).pipe(withEnv({})),
  );

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
          get(key) {
            return Effect.suspend(() => {
              reads += 1;
              if (reads === 1) {
                firstLookupStarted.resolve();
                return Effect.promise(() => firstLookup.promise);
              }
              return Effect.succeed(store.get(key));
            });
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
      }).pipe(withEnv({})),
  );

  // Regression: the key cache drop and the repaint signal belong to the
  // store's commit, so a writer outside the settings controllers (here the
  // setup agent's tool, on the CLI's file store) still reaches both.
  it.effect(
    'unset_api_key on a file-backed store drops the key cache and emits credentialChanged',
    () =>
      withTempDirEffect('texra-unset-key-', (root) =>
        Effect.gen(function* () {
          const secrets = new CliSecrets(path.join(root, 'secrets.json'));
          yield* secrets.set(apiKeySecretName('openai'), 'sk-test');
          yield* Effect.promise(() => setupApiKeyToolPlatform(secrets));
          expect(yield* lookupApiKeyOrigin(secrets, 'openai')).toBe('secret');

          const changed = Deferred.makeUnsafe<string>();
          const subscriber = yield* Effect.forkChild(
            onAppSignal('credentialChanged', ({ key }) => {
              Deferred.doneUnsafe(changed, Effect.succeed(key));
            }),
          );
          yield* Effect.yieldNow;

          yield* UnsetApiKeyTool.call({ provider: 'openai' }).pipe(
            Effect.provide(nativeToolTestLayer()),
          );

          expect(yield* lookupApiKeyOrigin(secrets, 'openai')).toBe('none');
          expect(yield* Deferred.await(changed)).toBe(
            apiKeySecretName('openai'),
          );
          yield* Fiber.interrupt(subscriber);
        }).pipe(withEnv({})),
      ),
  );

  it.effect('removes a stored key whose value can no longer be read', () =>
    Effect.gen(function* () {
      const { secrets, store } = createSecrets({
        [apiKeySecretName('openai')]: 'sk-test',
      });
      // The persisted entry is listed but unreadable: the removal path keys off
      // the stored key *names*, so it still has something to delete.
      vi.spyOn(secrets, 'get').mockReturnValue(Effect.succeed(undefined));
      vi.spyOn(secrets, 'getStored').mockReturnValue(Effect.succeed(undefined));
      yield* Effect.promise(() => setupApiKeyToolPlatform(secrets));

      const result = yield* UnsetApiKeyTool.call({ provider: 'openai' }).pipe(
        Effect.provide(nativeToolTestLayer()),
      );

      expect(result.status).toBe('executed');
      expect(result.output).toContain('Removed stored API key');
      expect(store.has(apiKeySecretName('openai'))).toBe(false);
    }),
  );

  it.effect(
    'reports the canonical Kimi Code environment variable when unsetting',
    () =>
      Effect.gen(function* () {
        const { secrets } = createSecrets({});
        yield* Effect.promise(() =>
          setupApiKeyToolPlatform(secrets, {
            [apiKeyEnvName('kimiCode')]: 'from-env',
          }),
        );

        const result = yield* UnsetApiKeyTool.call({
          provider: 'kimiCode',
        }).pipe(Effect.provide(nativeToolTestLayer()));

        expect(result.status).toBe('executed');
        expect(result.output).toContain('KIMI_CODE_API_KEY');
        expect(result.output).not.toContain('KIMICODE_API_KEY');
      }),
  );
});
