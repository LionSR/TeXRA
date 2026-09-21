// Node imports
import { strict as assert } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { describe } from 'vitest';

// Local imports - auth
import { callPort, settleFailure } from '@auth/authProgram';
import {
  SupabaseSessionCoordinator,
  toStorableSupabaseSession,
  type SupabaseSession,
} from '@auth/SupabaseSession';
import {
  DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
  parseStoredSupabaseSession,
  type SupabaseSessionStorage,
} from '@auth/supabaseSessionTypes';
import { createDeferred } from '@test/support/asyncTestUtils';
import type {
  Session as SupabaseNativeSession,
  SupabaseClient as Client,
} from '@supabase/supabase-js';

function makeSession(
  overrides: Partial<SupabaseSession> = {},
): SupabaseSession {
  return {
    id: 'user-id',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    account: { id: 'user-id', label: 'user@example.com' },
    expiresAt: Date.now() + 120_000,
    ...overrides,
  };
}

type SessionUser = { id: string; email: string | null };

function makeNativeSession(
  overrides: Partial<{ expires_at: number; user: SessionUser }> = {},
): SupabaseNativeSession {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: 123,
    user: { id: 'user-id', email: 'user@example.com' },
    ...overrides,
  } as unknown as SupabaseNativeSession;
}

function makeExchangeResponse(
  overrides: Partial<{ expires_at: number; user: SessionUser }> = {},
): {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  token_type: string;
  user: SessionUser;
} {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    user: { id: 'user-id', email: null },
    ...overrides,
  };
}

function expiredSession(): SupabaseSession {
  return makeSession({
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() - 1_000,
  });
}

function replacementSession(): SupabaseSession {
  return makeSession({
    accessToken: 'replacement-access',
    refreshToken: 'replacement-refresh',
  });
}

function createMemoryStorage(initial?: SupabaseSession): {
  storage: SupabaseSessionStorage;
  read: () => SupabaseSession | null;
  getReadCount: () => number;
} {
  let value = initial ? JSON.stringify(initial) : undefined;
  let readCount = 0;
  return {
    storage: {
      get: () =>
        Effect.sync(() => {
          readCount += 1;
          return value;
        }),
      store: (sessionData) =>
        Effect.sync(() => {
          value = sessionData;
        }),
      delete: () =>
        Effect.sync(() => {
          value = undefined;
        }),
    },
    read: () => parseStoredSupabaseSession(value),
    getReadCount: () => readCount,
  };
}

function createClient(overrides?: Partial<Client['auth']>): Client {
  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: 'user-id', email: 'user@example.com' } },
        error: null,
      }),
      refreshSession: async () => ({
        data: {
          session: {
            access_token: 'refreshed-access',
            refresh_token: 'refreshed-refresh',
            expires_at: 456,
            user: { id: 'user-id', email: 'user@example.com' },
          },
        },
        error: null,
      }),
      ...overrides,
    },
  } as unknown as Client;
}

const COORDINATOR_CONFIG = {
  whenReady: () => Effect.void,
  tokenRefreshThresholdMs: 60_000,
};

function createCoordinator(options?: {
  initialSession?: SupabaseSession;
  client?: Client;
}): {
  coordinator: SupabaseSessionCoordinator;
  read: () => SupabaseSession | null;
  getReadCount: () => number;
} {
  const { storage, read, getReadCount } = createMemoryStorage(
    options?.initialSession,
  );
  return {
    coordinator: new SupabaseSessionCoordinator({
      ...COORDINATOR_CONFIG,
      storage,
      getClient: () => options?.client ?? createClient(),
    }),
    read,
    getReadCount,
  };
}

// A coordinator whose storage triggers a session clear during its first read,
// to exercise races between loading a session and clearing it.
function createClearingStorageCoordinator(options: {
  initialSession: SupabaseSession;
  onFirstRead: (
    coordinator: SupabaseSessionCoordinator,
  ) => void | Promise<void>;
  onDelete?: () => Promise<void>;
}): {
  coordinator: SupabaseSessionCoordinator;
  getReadCount: () => number;
} {
  let value: string | undefined = JSON.stringify(options.initialSession);
  let readCount = 0;
  let clearDuringFirstRead = true;
  const storage: SupabaseSessionStorage = {
    get: () =>
      Effect.gen(function* () {
        readCount += 1;
        const snapshot = value;
        if (clearDuringFirstRead) {
          clearDuringFirstRead = false;
          const outcome = options.onFirstRead(coordinator);
          if (outcome) yield* Effect.promise(() => outcome);
        }
        return snapshot;
      }),
    store: (sessionData) =>
      Effect.sync(() => {
        value = sessionData;
      }),
    delete: () =>
      Effect.gen(function* () {
        if (options.onDelete) yield* Effect.promise(options.onDelete);
        value = undefined;
      }),
  };
  const coordinator = new SupabaseSessionCoordinator({
    ...COORDINATOR_CONFIG,
    storage,
    getClient: () => createClient(),
  });
  return { coordinator, getReadCount: () => readCount };
}

describe('SupabaseSession', () => {
  describe('parseStoredSupabaseSession', () => {
    it('returns null for invalid stored session data', () => {
      assert.equal(parseStoredSupabaseSession('{'), null);
      assert.equal(parseStoredSupabaseSession(JSON.stringify({ id: 1 })), null);
    });
  });

  describe('toStorableSupabaseSession', () => {
    it('converts Supabase native sessions into the stored shape', () => {
      const session = toStorableSupabaseSession(makeNativeSession());

      assert.equal(session.id, 'user-id');
      assert.equal(session.accessToken, 'access-token');
      assert.equal(session.refreshToken, 'refresh-token');
      assert.deepEqual(session.account, {
        id: 'user-id',
        label: 'user@example.com',
      });
      assert.equal(session.expiresAt, 123_000);
    });

    it('falls back to the user id when email is missing', () => {
      const nativeSession = makeNativeSession({
        user: { id: 'user-id', email: '' },
      });

      assert.equal(
        toStorableSupabaseSession(nativeSession).account.label,
        'user-id',
      );
    });

    it('uses the default expiry when native sessions omit expires_at', () => {
      const nativeSession = makeNativeSession({ expires_at: undefined });
      const earliestExpiry = Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS;

      const session = toStorableSupabaseSession(nativeSession);

      assert.ok(session.expiresAt >= earliestExpiry);
      assert.ok(
        session.expiresAt <= Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
      );
    });
  });

  describe('toStorableSupabaseSession exchange responses', () => {
    it('converts token exchange responses into the stored shape', () => {
      const session = toStorableSupabaseSession(
        makeExchangeResponse({
          expires_at: 123,
          user: { id: 'user-id', email: 'user@example.com' },
        }),
      );

      assert.deepEqual(session, {
        id: 'user-id',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        account: {
          id: 'user-id',
          label: 'user@example.com',
        },
        expiresAt: 123_000,
      });
    });
  });

  describe('SupabaseSessionCoordinator', () => {
    it.effect('exchanges a PKCE code from the query for a session', () =>
      Effect.gen(function* () {
        const client = {
          auth: {
            exchangeCodeForSession: async () => ({
              data: {
                session: {
                  access_token: 'pkce-access',
                  refresh_token: 'pkce-refresh',
                  expires_at: Math.floor(Date.now() / 1000) + 3600,
                  user: { id: 'user-id', email: 'user@example.com' },
                },
              },
              error: null,
            }),
          },
        } as unknown as Client;
        const { coordinator } = createCoordinator({ client });

        const result = yield* coordinator.createSessionFromCallback({
          path: '/auth-callback',
          query: 'code=pkce-code',
        });

        assert.equal(result.success, true);
        if (!result.success) return;
        assert.equal(result.session.accessToken, 'pkce-access');
        assert.equal(result.session.refreshToken, 'pkce-refresh');
        assert.deepEqual(result.session.account, {
          id: 'user-id',
          label: 'user@example.com',
        });
        assert.ok(result.session.expiresAt > Date.now());
      }),
    );

    it.effect('returns an auth error when PKCE code exchange fails', () =>
      Effect.gen(function* () {
        const client = {
          auth: {
            exchangeCodeForSession: async () => ({
              data: { session: null },
              error: { message: 'invalid code' },
            }),
          },
        } as unknown as Client;
        const { coordinator } = createCoordinator({ client });

        const result = yield* coordinator.createSessionFromCallback({
          path: '/auth-callback',
          query: 'code=bad-code',
        });

        assert.equal(result.success, false);
        if (result.success) return;
        assert.equal(result.error, 'invalid code');
        assert.equal(result.isAuthError, true);
      }),
    );

    it.effect(
      'rewrites a missing-verifier exchange failure as a dead link',
      () =>
        Effect.gen(function* () {
          const client = {
            auth: {
              exchangeCodeForSession: async () => ({
                data: { session: null },
                error: {
                  code: 'pkce_code_verifier_not_found',
                  message:
                    'PKCE code verifier not found in storage. ... use @supabase/ssr ...',
                },
              }),
            },
          } as unknown as Client;
          const { coordinator } = createCoordinator({ client });

          const result = yield* coordinator.createSessionFromCallback({
            path: '/auth-callback',
            query: 'code=stale-code',
          });

          assert.equal(result.success, false);
          if (result.success) return;
          assert.match(result.error, /no longer valid/);
          assert.doesNotMatch(result.error, /supabase\/ssr/);
          assert.equal(result.isAuthError, true);
        }),
    );

    it.effect('rejects retired implicit-token callbacks', () =>
      Effect.gen(function* () {
        const { coordinator } = createCoordinator();

        const result = yield* coordinator.createSessionFromCallback({
          path: '/auth-callback',
          query: new URLSearchParams({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
          }).toString(),
        });

        assert.deepEqual(result, {
          success: false,
          error: 'Missing authorization code in callback',
        });
      }),
    );

    it.live('returns refreshed session tokens without reloading storage', () =>
      Effect.gen(function* () {
        const { coordinator, getReadCount } = createCoordinator({
          initialSession: expiredSession(),
        });
        assert.deepEqual(yield* coordinator.getSessionTokens(), {
          accessToken: 'refreshed-access',
          refreshToken: 'refreshed-refresh',
        });
        assert.equal(getReadCount(), 1);
      }),
    );

    it.effect('does not return tokens cleared while loading the session', () =>
      Effect.gen(function* () {
        const { coordinator, getReadCount } = createClearingStorageCoordinator({
          initialSession: makeSession(),
          onFirstRead: (c) => Effect.runPromise(c.clearSession()),
        });

        assert.equal(yield* coordinator.getSessionTokens(), null);
        assert.equal(getReadCount(), 2);
      }),
    );

    it.effect(
      'does not return tokens when a clear is still pending after load',
      () =>
        Effect.gen(function* () {
          const deleteStarted = createDeferred();
          const allowDelete = createDeferred();
          const { coordinator, getReadCount } =
            createClearingStorageCoordinator({
              initialSession: makeSession(),
              onFirstRead: (c) => {
                void Effect.runPromise(c.clearSession());
              },
              onDelete: async () => {
                deleteStarted.resolve();
                await allowDelete.promise;
              },
            });

          const tokensFiber = yield* Effect.forkChild(
            coordinator.getSessionTokens(),
            { startImmediately: true },
          );
          yield* Effect.promise(() => deleteStarted.promise);
          allowDelete.resolve();

          assert.equal(yield* Fiber.join(tokensFiber), null);
          assert.equal(getReadCount(), 2);
        }),
    );

    it.live(
      'does not resurrect a cleared session when refresh finishes later',
      () =>
        Effect.gen(function* () {
          const refreshStarted = createDeferred();
          const allowRefresh = createDeferred();
          const client = createClient({
            refreshSession: async () => {
              refreshStarted.resolve();
              await allowRefresh.promise;
              return {
                data: {
                  session: {
                    access_token: 'refreshed-access',
                    refresh_token: 'refreshed-refresh',
                    expires_at: 456,
                    user: { id: 'user-id', email: 'user@example.com' },
                  },
                },
                error: null,
              };
            },
          } as unknown as Partial<Client['auth']>);
          const { coordinator, read } = createCoordinator({
            initialSession: expiredSession(),
            client,
          });

          const tokenFiber = yield* Effect.forkChild(
            coordinator.ensureFreshToken(),
            { startImmediately: true },
          );
          yield* Effect.promise(() => refreshStarted.promise);
          yield* coordinator.clearSession();
          allowRefresh.resolve();

          assert.equal(yield* Fiber.join(tokenFiber), null);
          assert.equal(read(), null);
        }),
    );

    it.live(
      'does not return a refreshed token when a clear is queued behind its store',
      () =>
        Effect.gen(function* () {
          const storeStarted = createDeferred();
          const allowStore = createDeferred();
          let value: string | undefined = JSON.stringify(expiredSession());
          const storage: SupabaseSessionStorage = {
            get: () => Effect.sync(() => value),
            store: (sessionData) =>
              Effect.gen(function* () {
                storeStarted.resolve();
                yield* Effect.promise(() => allowStore.promise);
                value = sessionData;
              }),
            delete: () =>
              Effect.sync(() => {
                value = undefined;
              }),
          };
          const coordinator = new SupabaseSessionCoordinator({
            ...COORDINATOR_CONFIG,
            storage,
            getClient: () => createClient(),
          });

          const tokenFiber = yield* Effect.forkChild(
            coordinator.ensureFreshToken(),
            { startImmediately: true },
          );
          yield* Effect.promise(() => storeStarted.promise);
          // The refresh's store is blocked mid-write; the clear queues behind it.
          const clearFiber = yield* Effect.forkChild(
            coordinator.clearSession(),
            { startImmediately: true },
          );
          yield* Effect.promise(() => delay(0));
          allowStore.resolve();

          assert.equal(yield* Fiber.join(tokenFiber), null);
          yield* Fiber.join(clearFiber);
          assert.equal(parseStoredSupabaseSession(value), null);
        }),
    );

    it.live(
      'reclassifies when a new session replaces one whose refresh failed',
      () =>
        Effect.gen(function* () {
          const refreshStarted = createDeferred();
          const allowRefreshFailure = createDeferred();
          const client = createClient({
            refreshSession: async () => {
              refreshStarted.resolve();
              await allowRefreshFailure.promise;
              return { data: { session: null }, error: { status: 401 } };
            },
          } as unknown as Partial<Client['auth']>);
          const { coordinator, read } = createCoordinator({
            initialSession: expiredSession(),
            client,
          });

          const stateFiber = yield* Effect.forkChild(
            coordinator.getStoredSessionState(),
            { startImmediately: true },
          );
          yield* Effect.promise(() => refreshStarted.promise);
          const replacement = replacementSession();
          yield* coordinator.storeSession(replacement);
          allowRefreshFailure.resolve();

          assert.equal(yield* Fiber.join(stateFiber), 'authenticated');
          assert.deepEqual(read(), replacement);
        }),
    );

    it.effect(
      'does not clear a replacement session after stale validation',
      () =>
        Effect.gen(function* () {
          const initialSession = makeSession({
            accessToken: 'old-access',
            refreshToken: 'old-refresh',
          });
          const { coordinator, read } = createCoordinator({ initialSession });
          const replacement = replacementSession();

          yield* coordinator.storeSession(replacement);

          assert.equal(
            yield* coordinator.clearSessionIfCurrent(initialSession),
            false,
          );
          assert.deepEqual(read(), replacement);
          assert.equal(
            yield* coordinator.clearSessionIfCurrent(replacement),
            true,
          );
          assert.equal(read(), null);
        }),
    );

    it.live.each([
      {
        status: 401,
        failure: 'invalid',
        request: (coordinator: SupabaseSessionCoordinator) =>
          coordinator.getSessionTokens(),
      },
      {
        status: 503,
        failure: 'transient',
        request: (coordinator: SupabaseSessionCoordinator) =>
          coordinator.ensureFreshToken(),
      },
    ])(
      'classifies refresh HTTP $status as $failure and returns no token',
      ({ status, failure, request }) =>
        Effect.gen(function* () {
          const client = createClient({
            refreshSession: async () => ({
              data: { session: null },
              error: { status },
            }),
          } as unknown as Partial<Client['auth']>);
          const { coordinator } = createCoordinator({
            initialSession: expiredSession(),
            client,
          });

          assert.equal(yield* request(coordinator), null);
          assert.equal(coordinator.getLastRefreshFailure(), failure);
        }),
    );
  });

  describe('port failure identity', () => {
    it.effect('settles a port rejection unchanged, whatever its shape', () =>
      Effect.gen(function* () {
        // The AuthPortError contract: `cause` is the caller's own error and the
        // fold a Promise-facing host boundary applies (`settleFailure`) hands it
        // back unchanged, so every `instanceof` and message check a host makes
        // still holds. A non-Error cause is the case that coercion destroys.
        const rejection = { status: 401, message: 'invalid_grant' };
        const exit = yield* Effect.exit(
          callPort(async () => {
            throw rejection;
          }),
        );

        assert.equal(
          Exit.isFailure(exit) ? settleFailure(exit.cause) : null,
          rejection,
        );
      }),
    );
  });
});
