import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { createSecretBackedCoordinator } from '../../../packages/llm/src/oauth/sessionAccess.js';
import type { CredentialStore as SessionSecretStore } from '@texra-ai/llm';

describe('createSecretBackedCoordinator', () => {
  function store(values: Record<string, string> = {}) {
    const secrets: SessionSecretStore = {
      get: (key) => Effect.succeed(values[key]),
      set: (key, value) =>
        Effect.sync(() => {
          values[key] = value;
        }),
      delete: (key) =>
        Effect.sync(() => {
          delete values[key];
        }),
    };
    return { values, secrets };
  }

  it.effect(
    'reuses one coordinator per store, so distinct stores share no state',
    () =>
      Effect.gen(function* () {
        const access = createSecretBackedCoordinator({
          secretKey: 'session',
          makeCoordinator: (storage) => ({ storage }),
        });
        const first = store();
        const second = store();

        const coordinator = access(first.secrets);
        expect(access(first.secrets)).toBe(coordinator);
        expect(access(second.secrets)).not.toBe(coordinator);

        yield* coordinator.storage.store('{"accessToken":"first"}');
        expect(first.values.session).toBe('{"accessToken":"first"}');
        expect(second.values.session).toBeUndefined();
      }),
  );
});
