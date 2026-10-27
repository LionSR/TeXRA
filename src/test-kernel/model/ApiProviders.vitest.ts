import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import {
  apiKeySecretName,
  hasUsableApiKey,
  lookupApiKey,
  lookupApiKeyOrigin,
  SecretsFailed,
} from '@texra-ai/llm';

import type { PlatformSecrets } from '@platform/secrets';
import { withEnv } from '@test/support/testEnv';

function createSecrets(initial: Record<string, string> = {}): PlatformSecrets {
  const store = new Map(Object.entries(initial));
  return {
    get: (key) => Effect.sync(() => store.get(key)),
    set: (key, value) =>
      Effect.sync(() => {
        store.set(key, value);
      }),
    delete: (key) =>
      Effect.sync(() => {
        store.delete(key);
      }),
    listStoredKeys: () => Effect.sync(() => [...store.keys()]),
  };
}

describe('API provider key resolution', () => {
  it.effect(
    'falls through blank stored values to a usable environment key',
    () =>
      Effect.gen(function* () {
        const secrets = createSecrets({
          [apiKeySecretName('openai')]: '   ',
        });

        expect(yield* lookupApiKeyOrigin(secrets, 'openai')).toBe('env');
        expect(yield* hasUsableApiKey(secrets, 'openai')).toBe(true);
      }).pipe(withEnv({ OPENAI_API_KEY: '  from-env  ' })),
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
        const secrets: PlatformSecrets = {
          ...createSecrets(),
          get: () => Effect.fail(readFailure),
        };

        expect(yield* Effect.flip(lookupApiKey(secrets, 'openai'))).toBe(
          readFailure,
        );
      }).pipe(withEnv({})),
  );
});
