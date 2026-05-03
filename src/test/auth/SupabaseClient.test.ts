// Standard library imports
import { strict as assert } from 'assert';

// Local imports - auth
import { SupabaseClient } from '@auth/SupabaseClient';
import type { AuthTokenProvider } from '@auth/TokenProvider';

describe('SupabaseClient', () => {
  afterEach(() => {
    SupabaseClient.resetForTests();
  });

  it('reads session tokens through the registered token provider', async () => {
    const provider: AuthTokenProvider = {
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
      ensureFreshToken: async () => 'access-token',
      getSessionTokens: async () => {
        throw new Error('storage unavailable');
      },
    };

    SupabaseClient.setAuthProvider(provider);

    assert.equal(await SupabaseClient.getSessionTokens(), null);
  });
});
