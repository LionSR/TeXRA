import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import {
  createSecretBackedCoordinator,
  getSubscriptionSessionStatus,
  type SessionAccessCoordinator,
  type SessionSecretStore,
} from '@auth/oauth/sessionAccess';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { captureLogEntries } from '@test/support/logSinkCapture';

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
    setLogSink(null);
  });

  it.effect(
    'warns on the caller-supplied channel and reports signed-out when the status read fails (#10635)',
    () =>
      Effect.gen(function* () {
        const logs = captureLogEntries();
        const failing = coordinator({
          getStatus: () => Effect.fail(new Error('secret store unavailable')),
        });

        const status = yield* getSubscriptionSessionStatus(
          () => failing,
          'subscriptionStatusProbe',
          'ChatGPT',
        ).pipe(Effect.provide(effectDiagnosticsLayer));

        expect(status).toEqual({ signedIn: false });
        expect(
          logs.has(
            'WARN',
            'subscriptionStatusProbe',
            'Failed to read ChatGPT session status: secret store unavailable',
          ),
        ).toBe(true);
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
