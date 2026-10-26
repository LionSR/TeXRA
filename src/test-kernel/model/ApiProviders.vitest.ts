import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import {
  apiKeySecretName,
  hasUsableApiKey,
  lookupApiKey,
  lookupApiKeyOrigin,
  SecretsFailed,
} from '@texra-ai/llm';

import type { PlatformSecrets } from '@platform/secrets';
import { withEnv } from '@test/support/testEnv';

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

describe('API provider key resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

        expect(yield* Effect.flip(lookupApiKey(secrets, 'openai'))).toBe(
          readFailure,
        );
      }).pipe(withEnv({})),
  );
});
