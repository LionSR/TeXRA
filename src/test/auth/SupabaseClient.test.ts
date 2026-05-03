// Standard library imports
import { strict as assert } from 'assert';

// Local imports - auth
import { SupabaseClient } from '@auth/SupabaseClient';
import type { AuthTokenProvider } from '@auth/TokenProvider';

describe('SupabaseClient', () => {
  it('reads session tokens through the registered token provider', async () => {
    const provider: AuthTokenProvider = {
      ensureFreshToken: async () => 'access-token',
      getSessionTokens: async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    };

    SupabaseClient.initialize('https://example.supabase.co', 'public-key');
    SupabaseClient.setAuthProvider(provider);

    assert.deepEqual(await SupabaseClient.getSessionTokens(), {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });
});
