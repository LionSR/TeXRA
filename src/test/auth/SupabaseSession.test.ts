// Standard library imports
import { strict as assert } from 'assert';

// Local imports - auth
import {
  DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
  parseStoredSupabaseSession,
  SupabaseSessionCoordinator,
  toStorableSupabaseSession,
  type SupabaseSession,
  type SupabaseSessionStorage,
} from '@auth/SupabaseSession';

// Third-party imports
import type {
  Session as SupabaseNativeSession,
  SupabaseClient as Client,
} from '@supabase/supabase-js';

function createMemoryStorage(initial?: SupabaseSession): {
  storage: SupabaseSessionStorage;
  read: () => SupabaseSession | null;
} {
  let value = initial ? JSON.stringify(initial) : undefined;
  return {
    storage: {
      get: async () => value,
      store: async (sessionData) => {
        value = sessionData;
      },
      delete: async () => {
        value = undefined;
      },
    },
    read: () => parseStoredSupabaseSession(value),
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

function createCoordinator(options?: {
  initialSession?: SupabaseSession;
  client?: Client;
  fetch?: typeof fetch;
  onTokenExpiryChanged?: (expiresAt: number | null) => void;
}): {
  coordinator: SupabaseSessionCoordinator;
  read: () => SupabaseSession | null;
} {
  const { storage, read } = createMemoryStorage(options?.initialSession);
  return {
    coordinator: new SupabaseSessionCoordinator({
      storage,
      getClient: () => options?.client ?? createClient(),
      whenReady: async () => {},
      tokenRefreshThresholdMs: 60_000,
      defaultSessionExpiryMs: DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
      githubTokenRefreshUrl: 'https://example.supabase.co/functions/v1/refresh',
      edgeFunctionTimeoutMs: 30_000,
      fetch: options?.fetch,
      onTokenExpiryChanged: options?.onTokenExpiryChanged,
    }),
    read,
  };
}

describe('SupabaseSession', () => {
  describe('parseStoredSupabaseSession', () => {
    it('returns null for missing session data', () => {
      assert.equal(parseStoredSupabaseSession(undefined), null);
    });

    it('parses valid stored session data', () => {
      const session: SupabaseSession = {
        id: 'user-id',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        account: {
          id: 'user-id',
          label: 'user@example.com',
        },
        expiresAt: Date.now() + 120_000,
      };

      assert.deepEqual(
        parseStoredSupabaseSession(JSON.stringify(session)),
        session,
      );
    });

    it('returns null for invalid stored session data', () => {
      assert.equal(parseStoredSupabaseSession('{'), null);
      assert.equal(parseStoredSupabaseSession(JSON.stringify({ id: 1 })), null);
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

  describe('SupabaseSessionCoordinator', () => {
    it('stores session data and exposes session tokens', async () => {
      const expiries: Array<number | null> = [];
      const { coordinator, read } = createCoordinator({
        onTokenExpiryChanged: (expiresAt) => expiries.push(expiresAt),
      });
      const session: SupabaseSession = {
        id: 'user-id',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        account: {
          id: 'user-id',
          label: 'user@example.com',
        },
        expiresAt: Date.now() + 120_000,
      };

      await coordinator.storeSession(session);

      assert.deepEqual(read(), session);
      assert.deepEqual(await coordinator.getSessionTokens(), {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
      assert.deepEqual(expiries, [session.expiresAt]);
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

    it('refreshes custom sessions through the injected fetch boundary', async () => {
      const initialSession: SupabaseSession = {
        id: 'user-id',
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        account: {
          id: 'user-id',
          label: 'user@example.com',
        },
        expiresAt: Date.now() - 1_000,
        useCustomRefresh: true,
      };
      const { coordinator, read } = createCoordinator({
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

      assert.deepEqual(read(), {
        id: 'user-id',
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        account: {
          id: 'user-id',
          label: 'new@example.com',
        },
        expiresAt: 789_000,
        useCustomRefresh: true,
      });
    });
  });
});
