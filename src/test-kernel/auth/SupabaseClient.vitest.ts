// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach, expect, vi } from 'vitest';

// Local imports - auth
import { SUPABASE_GOTRUE_STORAGE_KEY } from '@auth/config';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { AuthTokenProvider } from '@auth/TokenProvider';
import type { SessionSecretStore } from '@auth/oauth/sessionAccess';
import * as logger from '@logger/logUtils';
import { FakeSecrets } from '@test/support/FakePlatform';
import { createDeferred } from '@test/support/asyncTestUtils';

const SUPABASE_URL = 'https://example.supabase.co';
const PUBLIC_KEY = 'public-key';

function initializeSupabase(secrets: SessionSecretStore): void {
  SupabaseClient.initialize(SUPABASE_URL, PUBLIC_KEY, secrets);
}

function createTokenProvider(
  overrides: Partial<AuthTokenProvider> = {},
): AuthTokenProvider {
  return {
    whenReady: async () => {},
    ensureFreshToken: async () => 'access-token',
    getSessionTokens: async () => null,
    getStoredSessionState: async () => 'none',
    getStoredAccountLabel: async () => null,
    getLastRefreshFailure: () => null,
    ...overrides,
  };
}

/** Provider holding a refreshable session pair for `accessToken`. */
function sessionTokenProvider(accessToken: string): AuthTokenProvider {
  return createTokenProvider({
    ensureFreshToken: async () => accessToken,
    getSessionTokens: async () => ({
      accessToken,
      refreshToken: 'refresh-token',
    }),
  });
}

describe('SupabaseClient', () => {
  afterEach(() => {
    SupabaseClient.resetForTests();
    vi.restoreAllMocks();
  });

  it('reads session tokens through the registered token provider', async () => {
    SupabaseClient.setAuthProvider(sessionTokenProvider('access-token'));

    assert.deepEqual(await SupabaseClient.getSessionTokens(), {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });

  it('returns null when the token provider throws while reading session tokens', async () => {
    const provider = createTokenProvider({
      getSessionTokens: async () => {
        throw new Error('storage unavailable');
      },
    });

    SupabaseClient.setAuthProvider(provider);

    assert.equal(await SupabaseClient.getSessionTokens(), null);
  });

  it('waits for token provider readiness', async () => {
    const readiness = createDeferred();
    const provider = createTokenProvider({
      whenReady: () => readiness.promise,
    });

    initializeSupabase(new FakeSecrets());
    SupabaseClient.setAuthProvider(provider);

    let settled = false;
    const readyPromise = SupabaseClient.isReady().then((ready) => {
      settled = true;
      return ready;
    });
    await Promise.resolve();

    assert.equal(settled, false);

    readiness.resolve();

    assert.equal(await readyPromise, true);
  });

  it('reports not ready when token provider readiness fails', async () => {
    const provider = createTokenProvider({
      whenReady: async () => {
        throw new Error('host auth unavailable');
      },
    });

    initializeSupabase(new FakeSecrets());
    SupabaseClient.setAuthProvider(provider);

    assert.equal(await SupabaseClient.isReady(), false);
    assert.equal(
      SupabaseClient.getInitError()?.message,
      'host auth unavailable',
    );
  });

  it('warns and reports no label when the stored label read throws', async () => {
    SupabaseClient.setAuthProvider(
      createTokenProvider({
        getStoredAccountLabel: async () => {
          throw new Error('secret storage unavailable');
        },
      }),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(SupabaseClient.getStoredAccountLabel()).resolves.toBe(null);
    expect(warn).toHaveBeenCalledWith(
      'SupabaseClient',
      expect.stringContaining('secret storage unavailable'),
    );
  });
});

describe('SupabaseClient PKCE flow state', () => {
  const VERIFIER_KEY = `${SUPABASE_GOTRUE_STORAGE_KEY}-code-verifier`;

  afterEach(() => {
    SupabaseClient.resetForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Answer every code exchange with one session, capturing the request body.
   * Returns the captured body, which is only populated after the exchange.
   */
  function stubCodeExchange(): () => string {
    let body = '';
    const exchange: typeof fetch = async (_input, init) => {
      body = String(init?.body);
      return new Response(
        JSON.stringify({
          access_token: 'pkce-access',
          refresh_token: 'pkce-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          user: {
            id: 'user-id',
            aud: 'authenticated',
            email: 'user@example.com',
            app_metadata: {},
            user_metadata: {},
            created_at: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    vi.stubGlobal('fetch', exchange);
    return () => body;
  }

  /** Start browser OAuth without navigating, as a host window would. */
  async function startSignIn(): Promise<void> {
    const { error } = await SupabaseClient.getClient().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'https://remote.texra.ai/functions/v1/auth-bridge/cursor/x',
        skipBrowserRedirect: true,
      },
    });
    assert.equal(error, null);
  }

  it('persists only the flow state, never the session slot', async () => {
    const secrets = new FakeSecrets();
    initializeSupabase(secrets);

    await startSignIn();

    // A flow start writes its numbered slot, the slot index, and the fixed
    // legacy key the callback reads. All three are keys GoTrue derives from
    // its storage key; the storage key itself is the session slot and must
    // never appear here.
    const keys = await secrets.listStoredKeys();
    assert.ok(keys.includes(VERIFIER_KEY));
    assert.ok(!keys.includes(SUPABASE_GOTRUE_STORAGE_KEY));
    assert.ok(
      keys.every((key) => key.startsWith(`${SUPABASE_GOTRUE_STORAGE_KEY}-`)),
      `unexpected persisted keys: ${keys.join(', ')}`,
    );
  });

  it('completes a callback delivered to a different client instance', async () => {
    const secrets = new FakeSecrets();
    initializeSupabase(secrets);
    await startSignIn();
    // GoTrue JSON-encodes every stored value; the slot holds the verifier
    // alone, or `verifier/redirectType` for a recovery link.
    const stored: unknown = JSON.parse(
      (await secrets.getStored(VERIFIER_KEY)) ?? '',
    );
    const verifier = String(stored).split('/')[0];
    assert.ok(verifier);

    // A second window (or the same one after a host reload): a fresh client
    // that never generated a verifier of its own.
    const exchangeBody = stubCodeExchange();
    SupabaseClient.resetForTests();
    initializeSupabase(secrets);

    const { data, error } =
      await SupabaseClient.getClient().auth.exchangeCodeForSession('auth-code');

    assert.equal(error, null);
    assert.equal(data.session?.access_token, 'pkce-access');
    assert.deepEqual(JSON.parse(exchangeBody()), {
      auth_code: 'auth-code',
      code_verifier: verifier,
    });
    // The consumed verifier is cleared, and the session that replaced it is
    // not written here: the host's own session record stays its single owner.
    // (GoTrue leaves the numbered slot behind for a callback that carries no
    // flow id; its own ring caps those at five.)
    const remaining = await secrets.listStoredKeys();
    assert.ok(!remaining.includes(VERIFIER_KEY));
    assert.ok(!remaining.includes(SUPABASE_GOTRUE_STORAGE_KEY));
  });

  it('still signs in this window when the secret store is unwritable', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // A locked keychain answers an absent value (rather than throwing) on
    // reads and throws on writes; only the in-process mirror remains usable.
    const secrets: SessionSecretStore = {
      get: async () => undefined,
      set: async () => {
        throw new Error('keychain locked');
      },
      delete: async () => {},
    };
    initializeSupabase(secrets);

    await startSignIn();

    expect(warn).toHaveBeenCalledWith(
      'SupabaseClient',
      expect.stringContaining('keychain locked'),
    );

    // The callback lands in this window: the exchange must still succeed
    // using the mirrored verifier even though the store miss returned absent.
    const exchangeBody = stubCodeExchange();

    const { data, error } =
      await SupabaseClient.getClient().auth.exchangeCodeForSession('auth-code');

    assert.equal(error, null);
    assert.equal(data.session?.access_token, 'pkce-access');
    assert.ok(
      JSON.parse(exchangeBody()).code_verifier.length > 0,
      'the exchange reused the verifier mirrored in memory',
    );
  });
});
