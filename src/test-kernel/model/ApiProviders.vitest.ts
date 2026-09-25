import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { CliSecrets } from '@cli/runtime/cliSecrets';
import { onAppSignal } from '@eventBus/AppSignals';

import {
  apiKeySecretName,
  configuredApiKeyProviders,
  getApiKey,
  hasUsableApiKey,
  loadApiKeyStatusMap,
  lookupApiKey,
  lookupApiKeyOrigin,
} from '@model/apiProviders';
import { SecretsFailed, type PlatformSecrets } from '@platform/secrets';
import { apiKeyEnvName } from '@shared/constants/providers';
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

describe('API provider key resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect('derives provider status from the resolved API-key origin', () =>
    Effect.gen(function* () {
      const { secrets } = createSecrets({
        [apiKeySecretName('openai')]: 'sk-test',
      });

      expect(yield* loadApiKeyStatusMap(secrets, ['openai'])).toEqual({
        openai: 'set',
      });

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

  it.effect('treats empty env keys as missing', () =>
    Effect.gen(function* () {
      const { secrets } = createSecrets({});

      expect(yield* lookupApiKey(secrets, 'openai')).toBeUndefined();
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

  // Regression: the repaint signal belongs to the store's commit, so a writer
  // outside the settings controllers (here the setup agent's tool, on the
  // CLI's file store) still reaches it.
  it.effect(
    'unset_api_key on a file-backed store emits credentialChanged',
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
