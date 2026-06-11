// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'vitest';

// Standard library imports

// Local imports - auth
import {
  RELAY_CI_TOKEN_PREFIX,
  RELAY_TOKEN_ENV_VAR,
  fetchRelayTokenStatus,
  resetRelayTokenTierCacheForTests,
} from '@auth/relayToken';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { AuthTokenProvider } from '@auth/TokenProvider';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('SupabaseClient', () => {
  afterEach(() => {
    SupabaseClient.resetForTests();
    resetRelayTokenTierCacheForTests();
  });

  it('reads session tokens through the registered token provider', async () => {
    const provider: AuthTokenProvider = {
      whenReady: async () => {},
      ensureFreshToken: async () => 'access-token',
      getSessionTokens: async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    };

    SupabaseClient.setAuthProvider(provider);

    assert.deepEqual(await SupabaseClient.getSessionTokens(), {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });

  it('keeps session tokens separate from CI relay bearer tokens', async () => {
    const previousRelayToken = process.env[RELAY_TOKEN_ENV_VAR];
    process.env[RELAY_TOKEN_ENV_VAR] = `${RELAY_CI_TOKEN_PREFIX}abcdef`;
    const provider: AuthTokenProvider = {
      whenReady: async () => {},
      ensureFreshToken: async () => 'session-token',
      getSessionTokens: async () => ({
        accessToken: 'session-token',
        refreshToken: 'refresh-token',
      }),
    };

    try {
      SupabaseClient.setAuthProvider(provider);

      assert.equal(await SupabaseClient.getAccessToken(), 'session-token');
      assert.equal(
        await SupabaseClient.getRelayAccessToken(),
        `${RELAY_CI_TOKEN_PREFIX}abcdef`,
      );
      assert.equal(await SupabaseClient.isAuthenticated(), true);
    } finally {
      if (previousRelayToken === undefined) {
        delete process.env[RELAY_TOKEN_ENV_VAR];
      } else {
        process.env[RELAY_TOKEN_ENV_VAR] = previousRelayToken;
      }
    }
  });

  it('falls back to the session once the relay token is known-rejected', async () => {
    const previousRelayToken = process.env[RELAY_TOKEN_ENV_VAR];
    const relayToken = `${RELAY_CI_TOKEN_PREFIX}rejected`;
    process.env[RELAY_TOKEN_ENV_VAR] = relayToken;
    const provider: AuthTokenProvider = {
      whenReady: async () => {},
      ensureFreshToken: async () => 'session-token',
      getSessionTokens: async () => ({
        accessToken: 'session-token',
        refreshToken: 'refresh-token',
      }),
    };

    try {
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
    } finally {
      if (previousRelayToken === undefined) {
        delete process.env[RELAY_TOKEN_ENV_VAR];
      } else {
        process.env[RELAY_TOKEN_ENV_VAR] = previousRelayToken;
      }
    }
  });

  it('treats a relay-401 refresh as rejection of a static CI token', async () => {
    const previousRelayToken = process.env[RELAY_TOKEN_ENV_VAR];
    const relayToken = `${RELAY_CI_TOKEN_PREFIX}got401`;
    process.env[RELAY_TOKEN_ENV_VAR] = relayToken;
    const provider: AuthTokenProvider = {
      whenReady: async () => {},
      ensureFreshToken: async () => 'session-token',
      getSessionTokens: async () => null,
    };

    try {
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
    } finally {
      if (previousRelayToken === undefined) {
        delete process.env[RELAY_TOKEN_ENV_VAR];
      } else {
        process.env[RELAY_TOKEN_ENV_VAR] = previousRelayToken;
      }
    }
  });

  it('returns null when the token provider throws while reading session tokens', async () => {
    const provider: AuthTokenProvider = {
      whenReady: async () => {},
      ensureFreshToken: async () => 'access-token',
      getSessionTokens: async () => {
        throw new Error('storage unavailable');
      },
    };

    SupabaseClient.setAuthProvider(provider);

    assert.equal(await SupabaseClient.getSessionTokens(), null);
  });

  it('waits for token provider readiness', async () => {
    const readiness = createDeferred();
    const provider: AuthTokenProvider = {
      whenReady: () => readiness.promise,
      ensureFreshToken: async () => 'access-token',
      getSessionTokens: async () => null,
    };

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
    const provider: AuthTokenProvider = {
      whenReady: async () => {
        throw new Error('host auth unavailable');
      },
      ensureFreshToken: async () => 'access-token',
      getSessionTokens: async () => null,
    };

    SupabaseClient.initialize('https://example.supabase.co', 'public-key');
    SupabaseClient.setAuthProvider(provider);

    assert.equal(await SupabaseClient.isReady(), false);
    assert.equal(
      SupabaseClient.getInitError()?.message,
      'host auth unavailable',
    );
  });
});
