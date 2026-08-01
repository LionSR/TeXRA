// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach, expect, vi } from 'vitest';

// Local imports - auth
import {
  RELAY_CI_TOKEN_PREFIX,
  RELAY_TOKEN_ENV_VAR,
  fetchRelayTokenStatus,
  resetRelayTokenTierCacheForTests,
} from '@auth/relayToken';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { AuthTokenProvider } from '@auth/TokenProvider';
import * as logger from '@logger/logUtils';
import { createDeferred } from '@test/support/asyncTestUtils';

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

/** Registers a signed-in provider and a profile row carrying `tier`. */
function stubProfileTier(tier: unknown): void {
  SupabaseClient.setAuthProvider(
    createTokenProvider({
      getSessionTokens: async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    }),
  );
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
    const provider = createTokenProvider({
      getSessionTokens: async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    });

    SupabaseClient.setAuthProvider(provider);

    assert.deepEqual(await SupabaseClient.getSessionTokens(), {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });

  it('keeps session tokens separate from CI relay bearer tokens', async () => {
    const relayToken = `${RELAY_CI_TOKEN_PREFIX}abcdef`;
    const provider = createTokenProvider({
      ensureFreshToken: async () => 'session-token',
      getSessionTokens: async () => ({
        accessToken: 'session-token',
        refreshToken: 'refresh-token',
      }),
    });

    await withRelayTokenEnv(relayToken, async () => {
      SupabaseClient.setAuthProvider(provider);

      assert.equal(await SupabaseClient.getAccessToken(), 'session-token');
      assert.equal(await SupabaseClient.getRelayAccessToken(), relayToken);
      assert.equal(await SupabaseClient.isAuthenticated(), true);
      assert.equal(await SupabaseClient.canAccessRemoteAgentCatalog(), true);
    });
  });

  it('keeps relay-only model auth separate from remote catalog access', async () => {
    const relayToken = `${RELAY_CI_TOKEN_PREFIX}relayonly`;
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
    const relayToken = `${RELAY_CI_TOKEN_PREFIX}maskedsession`;
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
    const relayToken = `${RELAY_CI_TOKEN_PREFIX}rejected`;
    const provider = createTokenProvider({
      ensureFreshToken: async () => 'session-token',
      getSessionTokens: async () => ({
        accessToken: 'session-token',
        refreshToken: 'refresh-token',
      }),
    });

    await withRelayTokenEnv(relayToken, async () => {
      SupabaseClient.setAuthProvider(provider);

      // Observe the rejection (tier-config answers without userStatus for
      // unrecognized credentials); the settled status is cached.
      const publicConfig = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ tiers: {} }), { status: 200 }),
        )) as unknown as typeof fetch;
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
    const relayToken = `${RELAY_CI_TOKEN_PREFIX}got401`;
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

    SupabaseClient.initialize('https://example.supabase.co', 'public-key');
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

    SupabaseClient.initialize('https://example.supabase.co', 'public-key');
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
