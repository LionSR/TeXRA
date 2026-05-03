// Standard library imports
import { strict as assert } from 'assert';

// Local imports - auth
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
