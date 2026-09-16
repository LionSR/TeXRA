import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import {
  createSecretBackedCoordinator,
  getSubscriptionSessionStatus,
  type SessionAccessCoordinator,
  type SessionSecretStore,
} from '@auth/oauth/sessionAccess';
import * as logger from '@logger/logUtils';

function coordinator(
  overrides: Partial<SessionAccessCoordinator> = {},
): SessionAccessCoordinator {
  return {
    getStatus: () => Effect.succeed({ signedIn: false }),
    ...overrides,
  };
}

describe('getSubscriptionSessionStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect(
    'warns on the caller-supplied channel and reports signed-out when the status read fails (#10635)',
    () =>
      Effect.gen(function* () {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const failing = coordinator({
          getStatus: () => Effect.fail(new Error('secret store unavailable')),
        });

        const status = yield* getSubscriptionSessionStatus(
          () => failing,
          'subscriptionStatusProbe',
          'ChatGPT',
        );

        expect(status).toEqual({ signedIn: false });
        expect(warn).toHaveBeenCalledWith(
          'subscriptionStatusProbe',
          expect.stringContaining(
            'Failed to read ChatGPT session status: secret store unavailable',
          ),
        );
      }),
  );
});

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

  it('reuses one coordinator per store, so distinct stores share no state', async () => {
    const access = createSecretBackedCoordinator({
      secretKey: 'session',
      makeCoordinator: (storage) => ({ storage }),
    });
    const first = store();
    const second = store();

    const coordinator = access(first.secrets);
    expect(access(first.secrets)).toBe(coordinator);
    expect(access(second.secrets)).not.toBe(coordinator);

    await Effect.runPromise(
      coordinator.storage.store('{"accessToken":"first"}'),
    );
    expect(first.values.session).toBe('{"accessToken":"first"}');
    expect(second.values.session).toBeUndefined();
  });
});
