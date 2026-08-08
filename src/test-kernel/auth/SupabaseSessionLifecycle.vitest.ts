// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
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

// A refresh endpoint reply that migrates a custom-refresh session back onto the
// native path.
const REFRESHED_SESSION_BODY = JSON.stringify({
  access_token: 'new-access',
  refresh_token: 'new-refresh',
  expires_at: 789,
  token_type: 'bearer',
  user: {
    id: 'user-id',
    email: 'new@example.com',
  },
});

function expiredCustomSession(): SupabaseSession {
  return makeSession({
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() - 1_000,
    useCustomRefresh: true,
  });
}

function soonExpiringSession(): SupabaseSession {
  return makeSession({ expiresAt: Date.now() + 30_000 });
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
    get: async () => {
      readCount += 1;
      const snapshot = value;
      if (clearDuringFirstRead) {
        clearDuringFirstRead = false;
        await options.onFirstRead(coordinator);
      }
      return snapshot;
    },
    store: async (sessionData) => {
      value = sessionData;
    },
    delete: async () => {
      await options.onDelete?.();
      value = undefined;
    },
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
      const session = toStorableSupabaseSession(makeNativeSession(), {
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
      const nativeSession = makeNativeSession({
        user: { id: 'user-id', email: '  native@example.com  ' },
      });

      assert.equal(
        toStorableSupabaseSession(nativeSession).account.label,
        'native@example.com',
      );
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
      const session = toStorableSupabaseSession(makeExchangeResponse(), {
        fallbackLabel: '  github@example.com  ',
        defaultExpiryMs: DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
      });

      assert.equal(session.account.label, 'github@example.com');
    });

    it('falls back to the supplied label and default expiry', () => {
      const earliestExpiry = Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS;
      const session = toStorableSupabaseSession(makeExchangeResponse(), {
        fallbackLabel: 'fallback@example.com',
        defaultExpiryMs: DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
      });

      assert.equal(session.account.label, 'fallback@example.com');
      assert.ok(session.expiresAt >= earliestExpiry);
      assert.ok(
        session.expiresAt <= Date.now() + DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
      );
    });
  });

  describe('SupabaseSessionCoordinator', () => {
    it('stores session data and exposes session tokens', async () => {
      const { coordinator, read, getReadCount } = createCoordinator();
      const session = makeSession();

      await coordinator.storeSession(session);

      assert.deepEqual(read(), session);
      assert.deepEqual(await coordinator.getSessionTokens(), {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
      assert.equal(getReadCount(), 1);
      assert.equal(coordinator.isTokenExpiringSoon(), false);
    });

    it('reports no expiry pressure before any session is observed', () => {
      const { coordinator } = createCoordinator({
        initialSession: soonExpiringSession(),
      });

      assert.equal(coordinator.isTokenExpiringSoon(), false);
    });

    it('answers expiry pressure from a session loaded cold', async () => {
      const { coordinator } = createCoordinator({
        initialSession: soonExpiringSession(),
      });

      await coordinator.loadSession();

      assert.equal(coordinator.isTokenExpiringSoon(), true);
    });

    it('drops expiry pressure once the session is cleared', async () => {
      const { coordinator } = createCoordinator({
        initialSession: soonExpiringSession(),
      });

      await coordinator.loadSession();
      await coordinator.clearSession();

      assert.equal(coordinator.isTokenExpiringSoon(), false);
    });

    it('drops expiry pressure when a matched session is cleared', async () => {
      const session = soonExpiringSession();
      const { coordinator } = createCoordinator({ initialSession: session });

      await coordinator.loadSession();
      assert.equal(await coordinator.clearSessionIfCurrent(session), true);

      assert.equal(coordinator.isTokenExpiringSoon(), false);
    });

    it('reads storage once when ensuring a cached fresh token', async () => {
      const initialSession = makeSession();
      const { coordinator, getReadCount } = createCoordinator({
        initialSession,
      });

      assert.equal(await coordinator.ensureFreshToken(), 'access-token');
      assert.equal(getReadCount(), 1);
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

    it('rewrites a missing-verifier exchange failure as a dead link', async () => {
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

      const result = await coordinator.createSessionFromCallback({
        path: '/auth-callback',
        query: 'code=stale-code',
      });

      assert.equal(result.success, false);
      if (result.success) return;
      assert.match(result.error, /no longer valid/);
      assert.doesNotMatch(result.error, /supabase\/ssr/);
      assert.equal(result.isAuthError, true);
    });

    it('rejects retired implicit-token callbacks', async () => {
      const { coordinator } = createCoordinator();

      const result = await coordinator.createSessionFromCallback({
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
    });

    it('refreshes custom sessions through the injected fetch boundary', async () => {
      const { coordinator, read, getReadCount } = createCoordinator({
        initialSession: expiredCustomSession(),
        fetch: async () =>
          new Response(REFRESHED_SESSION_BODY, { status: 200 }),
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
      const { coordinator, getReadCount } = createCoordinator({
        initialSession: expiredCustomSession(),
        fetch: async () =>
          new Response(REFRESHED_SESSION_BODY, { status: 200 }),
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
      const { coordinator, getReadCount } = createClearingStorageCoordinator({
        initialSession: makeSession(),
        onFirstRead: (c) => c.clearSession(),
      });

      assert.equal(await coordinator.getSessionTokens(), null);
      assert.equal(getReadCount(), 2);
    });

    it('does not return tokens when a clear is still pending after load', async () => {
      const deleteStarted = createDeferred();
      const allowDelete = createDeferred();
      const { coordinator, getReadCount } = createClearingStorageCoordinator({
        initialSession: makeSession(),
        onFirstRead: (c) => {
          void c.clearSession();
        },
        onDelete: async () => {
          deleteStarted.resolve();
          await allowDelete.promise;
        },
      });

      const tokensPromise = coordinator.getSessionTokens();
      await deleteStarted.promise;
      allowDelete.resolve();

      assert.equal(await tokensPromise, null);
      assert.equal(getReadCount(), 2);
    });

    it('does not resurrect a cleared session when refresh finishes later', async () => {
      const refreshStarted = createDeferred();
      const allowRefresh = createDeferred();
      const { coordinator, read } = createCoordinator({
        initialSession: expiredCustomSession(),
        fetch: async () => {
          refreshStarted.resolve();
          await allowRefresh.promise;
          return new Response(REFRESHED_SESSION_BODY);
        },
      });

      const tokenPromise = coordinator.ensureFreshToken();
      await refreshStarted.promise;
      await coordinator.clearSession();
      allowRefresh.resolve();

      assert.equal(await tokenPromise, null);
      assert.equal(read(), null);
    });

    it('reclassifies when a new session replaces one whose refresh failed', async () => {
      const refreshStarted = createDeferred();
      const allowRefreshFailure = createDeferred();
      const { coordinator, read } = createCoordinator({
        initialSession: expiredCustomSession(),
        fetch: async () => {
          refreshStarted.resolve();
          await allowRefreshFailure.promise;
          return new Response(
            JSON.stringify({ error: 'invalid refresh token' }),
            { status: 401 },
          );
        },
      });

      const statePromise = coordinator.getStoredSessionState();
      await refreshStarted.promise;
      const replacement = replacementSession();
      await coordinator.storeSession(replacement);
      allowRefreshFailure.resolve();

      assert.equal(await statePromise, 'authenticated');
      assert.deepEqual(read(), replacement);
    });

    it('does not clear a replacement session after stale validation', async () => {
      const initialSession = makeSession({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
      });
      const { coordinator, read } = createCoordinator({ initialSession });
      const replacement = replacementSession();

      await coordinator.storeSession(replacement);

      assert.equal(
        await coordinator.clearSessionIfCurrent(initialSession),
        false,
      );
      assert.deepEqual(read(), replacement);
      assert.equal(await coordinator.clearSessionIfCurrent(replacement), true);
      assert.equal(read(), null);
    });

    it.each([
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
      'classifies custom refresh HTTP $status as $failure and returns no token',
      async ({ status, failure, request }) => {
        const { coordinator } = createCoordinator({
          initialSession: expiredCustomSession(),
          fetch: async () =>
            new Response(JSON.stringify({ error: 'refresh rejected' }), {
              status,
            }),
        });

        assert.equal(await request(coordinator), null);
        assert.equal(coordinator.getLastRefreshFailure(), failure);
      },
    );

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
