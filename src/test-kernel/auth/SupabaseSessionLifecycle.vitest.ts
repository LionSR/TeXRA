// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - auth
import {
  DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
  parseStoredSupabaseSession,
  SupabaseSessionCoordinator,
  toStorableSupabaseSession,
  type SupabaseSession,
  type SupabaseSessionStorage,
} from '@auth/SupabaseSession';
import { fetchWithTimeout } from '@auth/fetchWithTimeout';

// Third-party imports
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

function createMemoryStorage(initial?: SupabaseSession): {
  storage: SupabaseSessionStorage;
  read: () => SupabaseSession | null;
  getReadCount: () => number;
} {
  let value = initial ? JSON.stringify(initial) : undefined;
  let readCount = 0;
  return {
    storage: {
      get: async () => {
        readCount += 1;
        return value;
      },
      store: async (sessionData) => {
        value = sessionData;
      },
      delete: async () => {
        value = undefined;
      },
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

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

const COORDINATOR_CONFIG = {
  whenReady: async () => {},
  tokenRefreshThresholdMs: 60_000,
  defaultSessionExpiryMs: DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
  githubTokenRefreshUrl: 'https://example.supabase.co/functions/v1/refresh',
  edgeFunctionTimeoutMs: 30_000,
};

function createCoordinator(options?: {
  initialSession?: SupabaseSession;
  client?: Client;
  fetch?: typeof fetch;
  onTokenExpiryChanged?: (expiresAt: number | null) => void;
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
      fetch: options?.fetch,
      onTokenExpiryChanged: options?.onTokenExpiryChanged,
    }),
    read,
    getReadCount,
  };
}

describe('SupabaseSession', () => {
  describe('parseStoredSupabaseSession', () => {
    it('returns null for missing session data', () => {
      assert.equal(parseStoredSupabaseSession(undefined), null);
    });

    it('parses valid stored session data', () => {
      const session = makeSession();

      assert.deepEqual(
        parseStoredSupabaseSession(JSON.stringify(session)),
        session,
      );
    });

    it('returns null for invalid stored session data', () => {
      assert.equal(parseStoredSupabaseSession('{'), null);
      assert.equal(parseStoredSupabaseSession(JSON.stringify({ id: 1 })), null);
    });

    it('trims whitespace from the account label on parse', () => {
      const session = makeSession({
        account: { id: 'user-id', label: '  stored@example.com  ' },
      });

      assert.equal(
        parseStoredSupabaseSession(JSON.stringify(session))?.account.label,
        'stored@example.com',
      );
    });
  });

  describe('toStorableSupabaseSession', () => {
    it('converts Supabase native sessions into the stored shape', () => {
      const nativeSession = {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: 123,
        user: {
          id: 'user-id',
          email: 'user@example.com',
        },
      } as unknown as SupabaseNativeSession;

      const session = toStorableSupabaseSession(nativeSession, {
        useCustomRefresh: true,
      });

      assert.equal(session.id, 'user-id');
      assert.equal(session.accessToken, 'access-token');
      assert.equal(session.refreshToken, 'refresh-token');
      assert.deepEqual(session.account, {
        id: 'user-id',
        label: 'user@example.com',
      });
      assert.equal(session.expiresAt, 123_000);
      assert.equal(session.useCustomRefresh, true);
    });

    it('trims whitespace from the native session email label', () => {
      const nativeSession = {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: 123,
        user: {
          id: 'user-id',
          email: '  native@example.com  ',
        },
      } as unknown as SupabaseNativeSession;

      assert.equal(
        toStorableSupabaseSession(nativeSession).account.label,
        'native@example.com',
      );
    });

    it('falls back to the user id when email is missing', () => {
      const nativeSession = {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: 123,
        user: {
          id: 'user-id',
          email: '',
        },
      } as unknown as SupabaseNativeSession;

      assert.equal(
        toStorableSupabaseSession(nativeSession).account.label,
        'user-id',
      );
    });

    it('uses the default expiry when native sessions omit expires_at', () => {
      const nativeSession = {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        user: {
          id: 'user-id',
          email: 'user@example.com',
        },
      } as unknown as SupabaseNativeSession;
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
        {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_at: 123,
          token_type: 'bearer',
          user: {
            id: 'user-id',
            email: 'user@example.com',
          },
        },
        {
          fallbackLabel: 'fallback@example.com',
          defaultExpiryMs: DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
        },
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

    it('trims whitespace from the exchange fallback label', () => {
      const session = toStorableSupabaseSession(
        {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'bearer',
          user: {
            id: 'user-id',
            email: null,
          },
        },
        {
          fallbackLabel: '  github@example.com  ',
          defaultExpiryMs: DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
        },
      );

      assert.equal(session.account.label, 'github@example.com');
    });

    it('falls back to the supplied label and default expiry', () => {
      const earliestExpiry = Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS;
      const session = toStorableSupabaseSession(
        {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'bearer',
          user: {
            id: 'user-id',
            email: null,
          },
        },
        {
          fallbackLabel: 'fallback@example.com',
          defaultExpiryMs: DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
        },
      );

      assert.equal(session.account.label, 'fallback@example.com');
      assert.ok(session.expiresAt >= earliestExpiry);
      assert.ok(
        session.expiresAt <= Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
      );
    });
  });

  describe('SupabaseSessionCoordinator', () => {
    it('stores session data and exposes session tokens', async () => {
      const expiries: Array<number | null> = [];
      const { coordinator, read, getReadCount } = createCoordinator({
        onTokenExpiryChanged: (expiresAt) => expiries.push(expiresAt),
      });
      const session = makeSession();

      await coordinator.storeSession(session);

      assert.deepEqual(read(), session);
      assert.deepEqual(await coordinator.getSessionTokens(), {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
      assert.equal(getReadCount(), 1);
      assert.deepEqual(expiries, [session.expiresAt]);
    });

    it('reads storage once when ensuring a cached fresh token', async () => {
      const initialSession = makeSession();
      const { coordinator, getReadCount } = createCoordinator({
        initialSession,
      });

      assert.equal(await coordinator.ensureFreshToken(), 'access-token');
      assert.equal(getReadCount(), 1);
    });

    it('creates a session from host-neutral callback URI parts', async () => {
      const { coordinator } = createCoordinator();

      const result = await coordinator.createSessionFromCallback({
        path: '/auth-callback',
        fragment: new URLSearchParams({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: '3600',
        }).toString(),
      });

      assert.equal(result.success, true);
      if (!result.success) return;
      assert.equal(result.session.id, 'user-id');
      assert.equal(result.session.accessToken, 'access-token');
      assert.equal(result.session.refreshToken, 'refresh-token');
      assert.deepEqual(result.session.account, {
        id: 'user-id',
        label: 'user@example.com',
      });
      assert.ok(result.session.expiresAt > Date.now());
    });

    it('exchanges a PKCE code from the query for a session', async () => {
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

      const result = await coordinator.createSessionFromCallback({
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
    });

    it('returns an auth error when PKCE code exchange fails', async () => {
      const client = {
        auth: {
          exchangeCodeForSession: async () => ({
            data: { session: null },
            error: { message: 'invalid code' },
          }),
        },
      } as unknown as Client;
      const { coordinator } = createCoordinator({ client });

      const result = await coordinator.createSessionFromCallback({
        path: '/auth-callback',
        query: 'code=bad-code',
      });

      assert.equal(result.success, false);
      if (result.success) return;
      assert.equal(result.error, 'invalid code');
      assert.equal(result.isAuthError, true);
    });

    it('falls back to default callback expiry when expires_in is invalid', async () => {
      const { coordinator } = createCoordinator();
      const earliestExpiry = Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS;

      const result = await coordinator.createSessionFromCallback({
        path: '/auth-callback',
        fragment: new URLSearchParams({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 'not-a-number',
        }).toString(),
      });

      assert.equal(result.success, true);
      if (!result.success) return;
      assert.ok(result.session.expiresAt >= earliestExpiry);
      assert.ok(
        result.session.expiresAt <=
          Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
      );
    });

    it('refreshes custom sessions through the injected fetch boundary', async () => {
      const initialSession = makeSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1_000,
        useCustomRefresh: true,
      });
      const { coordinator, read, getReadCount } = createCoordinator({
        initialSession,
        fetch: async () =>
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_at: 789,
              token_type: 'bearer',
              user: {
                id: 'user-id',
                email: 'new@example.com',
              },
            }),
            { status: 200 },
          ),
      });

      assert.equal(await coordinator.ensureFreshToken(), 'new-access');
      assert.equal(getReadCount(), 1);

      // The refresh endpoint returns a native GoTrue session, so the stored
      // result drops useCustomRefresh and migrates to the standard path.
      assert.deepEqual(read(), {
        id: 'user-id',
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        account: {
          id: 'user-id',
          label: 'new@example.com',
        },
        expiresAt: 789_000,
      });
    });

    it('force-refreshes native sessions without reloading storage', async () => {
      const initialSession = makeSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
      });
      const { coordinator, getReadCount } = createCoordinator({
        initialSession,
      });

      assert.equal(
        await coordinator.ensureFreshToken(true),
        'refreshed-access',
      );
      assert.equal(getReadCount(), 1);
    });

    it('returns refreshed session tokens without reloading storage', async () => {
      const initialSession = makeSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1_000,
        useCustomRefresh: true,
      });
      const { coordinator, getReadCount } = createCoordinator({
        initialSession,
        fetch: async () =>
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_at: 789,
              token_type: 'bearer',
              user: {
                id: 'user-id',
                email: 'new@example.com',
              },
            }),
            { status: 200 },
          ),
      });

      assert.deepEqual(await coordinator.getSessionTokens(), {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      });
      assert.equal(getReadCount(), 1);
    });

    it('returns native refreshed session tokens without reloading storage', async () => {
      const initialSession = makeSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1_000,
      });
      const { coordinator, getReadCount } = createCoordinator({
        initialSession,
      });

      assert.deepEqual(await coordinator.getSessionTokens(), {
        accessToken: 'refreshed-access',
        refreshToken: 'refreshed-refresh',
      });
      assert.equal(getReadCount(), 1);
    });

    it('does not return tokens cleared while loading the session', async () => {
      const initialSession = makeSession();
      let value: string | undefined = JSON.stringify(initialSession);
      let readCount = 0;
      let clearDuringFirstRead = true;
      const coordinatorRef: { current?: SupabaseSessionCoordinator } = {};
      const storage: SupabaseSessionStorage = {
        get: async () => {
          readCount += 1;
          const snapshot = value;
          if (clearDuringFirstRead) {
            clearDuringFirstRead = false;
            await coordinatorRef.current?.clearSession();
          }
          return snapshot;
        },
        store: async (sessionData) => {
          value = sessionData;
        },
        delete: async () => {
          value = undefined;
        },
      };
      const coordinator = new SupabaseSessionCoordinator({
        ...COORDINATOR_CONFIG,
        storage,
        getClient: () => createClient(),
      });
      coordinatorRef.current = coordinator;

      assert.equal(await coordinator.getSessionTokens(), null);
      assert.equal(readCount, 2);
    });

    it('does not return tokens when a clear is still pending after load', async () => {
      const initialSession = makeSession();
      let value: string | undefined = JSON.stringify(initialSession);
      let readCount = 0;
      let clearDuringFirstRead = true;
      const deleteStarted = createDeferred();
      const allowDelete = createDeferred();
      const coordinatorRef: { current?: SupabaseSessionCoordinator } = {};
      const storage: SupabaseSessionStorage = {
        get: async () => {
          readCount += 1;
          const snapshot = value;
          if (clearDuringFirstRead) {
            clearDuringFirstRead = false;
            void coordinatorRef.current?.clearSession();
          }
          return snapshot;
        },
        store: async (sessionData) => {
          value = sessionData;
        },
        delete: async () => {
          deleteStarted.resolve();
          await allowDelete.promise;
          value = undefined;
        },
      };
      const coordinator = new SupabaseSessionCoordinator({
        ...COORDINATOR_CONFIG,
        storage,
        getClient: () => createClient(),
      });
      coordinatorRef.current = coordinator;

      const tokensPromise = coordinator.getSessionTokens();
      await deleteStarted.promise;
      allowDelete.resolve();

      assert.equal(await tokensPromise, null);
      assert.equal(readCount, 2);
    });

    it('does not resurrect a cleared session when refresh finishes later', async () => {
      const initialSession = makeSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1_000,
        useCustomRefresh: true,
      });
      const refreshStarted = createDeferred();
      const allowRefresh = createDeferred();
      const { coordinator, read } = createCoordinator({
        initialSession,
        fetch: async () => {
          refreshStarted.resolve();
          await allowRefresh.promise;
          return new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_at: 123,
              token_type: 'bearer',
              user: {
                id: 'user-id',
                email: 'user@example.com',
              },
            }),
          );
        },
      });

      const tokenPromise = coordinator.ensureFreshToken();
      await refreshStarted.promise;
      await coordinator.clearSession();
      allowRefresh.resolve();

      assert.equal(await tokenPromise, null);
      assert.equal(read(), null);
    });

    it('does not return expired session tokens when refresh fails', async () => {
      const initialSession = makeSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: Date.now() - 1_000,
        useCustomRefresh: true,
      });
      const { coordinator } = createCoordinator({
        initialSession,
        fetch: async () =>
          new Response(JSON.stringify({ error: 'invalid refresh token' }), {
            status: 401,
          }),
      });

      assert.equal(await coordinator.getSessionTokens(), null);
    });

    it('preserves upstream abort signals when adding a timeout', async () => {
      const upstream = new AbortController();
      let fetchSignal: AbortSignal | undefined;

      await fetchWithTimeout(
        'https://example.com',
        { signal: upstream.signal },
        30_000,
        'timeout',
        async (_url, init) => {
          fetchSignal = init?.signal ?? undefined;
          upstream.abort();
          assert.equal(fetchSignal?.aborted, true);
          return new Response(null, { status: 204 });
        },
      );

      assert.ok(fetchSignal);
    });

    it('preserves upstream abort errors instead of reporting timeout', async () => {
      const upstream = new AbortController();

      await assert.rejects(
        fetchWithTimeout(
          'https://example.com',
          { signal: upstream.signal },
          30_000,
          'timeout',
          async (_url, init) => {
            upstream.abort();
            throw new DOMException(
              init?.signal?.reason ?? 'Aborted',
              'AbortError',
            );
          },
        ),
        (error) =>
          error instanceof DOMException &&
          error.name === 'AbortError' &&
          error.message !== 'timeout',
      );
    });
  });
});
