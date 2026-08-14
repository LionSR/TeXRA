// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach, expect, vi } from 'vitest';

// Local imports - auth
import { SUPABASE_GOTRUE_STORAGE_KEY } from '@auth/config';
import {
  RELAY_CI_TOKEN_PREFIX,
  RELAY_TOKEN_ENV_VAR,
  fetchRelayTokenStatus,
  resetRelayTokenTierCacheForTests,
} from '@auth/relayToken';
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

async function withRelayTokenEnv(
  token: string,
  run: () => Promise<void>,
): Promise<void> {
  const previous = process.env[RELAY_TOKEN_ENV_VAR];
  process.env[RELAY_TOKEN_ENV_VAR] = token;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[RELAY_TOKEN_ENV_VAR];
    } else {
      process.env[RELAY_TOKEN_ENV_VAR] = previous;
    }
  }
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
    isTokenExpiringSoon: () => false,
    getLastRefreshFailure: () => null,
    ...overrides,
  };
}

function relayCiToken(label: string): string {
  return `${RELAY_CI_TOKEN_PREFIX}${label}`;
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

/** Registers a signed-in provider and a profile row carrying `tier`. */
function stubProfileTier(tier: unknown): void {
  SupabaseClient.setAuthProvider(sessionTokenProvider('access-token'));
  vi.spyOn(SupabaseClient, 'getClient').mockReturnValue({
    auth: { setSession: vi.fn(async () => {}) },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => ({ data: { tier }, error: null })),
      })),
    })),
  } as never);
}

describe('SupabaseClient', () => {
  afterEach(() => {
    SupabaseClient.resetForTests();
    resetRelayTokenTierCacheForTests();
    vi.restoreAllMocks();
  });

  it('reads session tokens through the registered token provider', async () => {
    SupabaseClient.setAuthProvider(sessionTokenProvider('access-token'));

    assert.deepEqual(await SupabaseClient.getSessionTokens(), {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });

  it('keeps session tokens separate from CI relay bearer tokens', async () => {
    const relayToken = relayCiToken('abcdef');

    await withRelayTokenEnv(relayToken, async () => {
      SupabaseClient.setAuthProvider(sessionTokenProvider('session-token'));

      assert.equal(await SupabaseClient.getAccessToken(), 'session-token');
      assert.equal(await SupabaseClient.getRelayAccessToken(), relayToken);
      assert.equal(await SupabaseClient.isAuthenticated(), true);
      assert.equal(await SupabaseClient.canAccessRemoteAgentCatalog(), true);
    });
  });

  it('keeps relay-only model auth separate from remote catalog access', async () => {
    const relayToken = relayCiToken('relayonly');
    const provider = createTokenProvider({
      ensureFreshToken: async () => null,
    });

    await withRelayTokenEnv(relayToken, async () => {
      SupabaseClient.setAuthProvider(provider);

      assert.equal(SupabaseClient.hasUsableRelayToken(), true);
      assert.equal(await SupabaseClient.isAuthenticated(), true);
      assert.equal(await SupabaseClient.getRelayAccessToken(), relayToken);
      assert.equal(await SupabaseClient.canAccessRemoteAgentCatalog(), false);
    });
  });

  it('classifies a stored session independently of relay authentication', async () => {
    const relayToken = relayCiToken('maskedsession');
    const provider = createTokenProvider({
      ensureFreshToken: async () => null,
      getSessionTokens: async () => null,
      getStoredSessionState: async () => 'invalid',
      getLastRefreshFailure: () => 'invalid',
    });

    await withRelayTokenEnv(relayToken, async () => {
      SupabaseClient.setAuthProvider(provider);

      assert.equal(await SupabaseClient.isAuthenticated(), true);
      assert.equal(await SupabaseClient.getStoredSessionState(), 'invalid');
    });
  });

  it('falls back to the session once the relay token is known-rejected', async () => {
    const relayToken = relayCiToken('rejected');

    await withRelayTokenEnv(relayToken, async () => {
      SupabaseClient.setAuthProvider(sessionTokenProvider('session-token'));

      // Observe the rejection (tier-config answers without userStatus for
      // unrecognized credentials); the settled status is cached.
      const publicConfig = async () =>
        new Response(JSON.stringify({ tiers: {} }), { status: 200 });
      assert.deepEqual(await fetchRelayTokenStatus(relayToken, publicConfig), {
        state: 'invalid',
      });

      // Relay-bound calls and auth checks skip the rejected token and use
      // the stored session instead of presenting a credential that will 401.
      assert.equal(await SupabaseClient.getRelayAccessToken(), 'session-token');
      assert.equal(await SupabaseClient.isAuthenticated(), true);
    });
  });

  it('treats a relay-401 refresh as rejection of a static CI token', async () => {
    const relayToken = relayCiToken('got401');
    const provider = createTokenProvider({
      ensureFreshToken: async () => 'session-token',
    });

    await withRelayTokenEnv(relayToken, async () => {
      SupabaseClient.setAuthProvider(provider);

      // The 401-recovery path (forceRefresh) presented the CI token; a static
      // token cannot be refreshed, so the rejection is recorded and the call
      // falls back to the refreshable session.
      assert.equal(
        await SupabaseClient.getRelayAccessToken(true),
        'session-token',
      );
      // Subsequent relay calls keep skipping the rejected token.
      assert.equal(await SupabaseClient.getRelayAccessToken(), 'session-token');
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

  it('logs a malformed profile tier instead of accepting it as free', async () => {
    stubProfileTier('corrupted');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(SupabaseClient.getSessionTier()).resolves.toBe('free');
    expect(error).toHaveBeenCalledWith(
      'SupabaseClient',
      expect.stringContaining('Error getting user tier:'),
    );
  });

  it('treats a null profile tier as free without reporting corruption', async () => {
    stubProfileTier(null);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(SupabaseClient.getSessionTier()).resolves.toBe('free');
    expect(error).not.toHaveBeenCalled();
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

  it('reports no expiry pressure when no token provider is registered', () => {
    assert.equal(SupabaseClient.isTokenExpiringSoon(), false);
  });

  it('reports the token provider expiry verdict', () => {
    SupabaseClient.setAuthProvider(
      createTokenProvider({ isTokenExpiringSoon: () => true }),
    );

    assert.equal(SupabaseClient.isTokenExpiringSoon(), true);
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
