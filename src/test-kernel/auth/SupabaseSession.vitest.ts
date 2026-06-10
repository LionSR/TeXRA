// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - auth
import {
  DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
  parseStoredSupabaseSession,
  toStorableSupabaseSession,
  type SupabaseSession,
} from '@auth/SupabaseSession';
import type { Session as SupabaseNativeSession } from '@supabase/supabase-js';

describe('SupabaseSession account labels', () => {
  it('normalizes stored and newly-created account labels at the auth boundary', () => {
    const stored: SupabaseSession = {
      id: 'user-id',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      account: {
        id: 'user-id',
        label: '  stored@example.com  ',
      },
      expiresAt: Date.now() + 120_000,
    };
    const nativeSession = {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: 123,
      user: {
        id: 'user-id',
        email: '  native@example.com  ',
      },
    } as unknown as SupabaseNativeSession;
    const githubSession = toStorableSupabaseSession(
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

    expect(
      parseStoredSupabaseSession(JSON.stringify(stored))?.account.label,
    ).toBe('stored@example.com');
    expect(toStorableSupabaseSession(nativeSession).account.label).toBe(
      'native@example.com',
    );
    expect(githubSession.account.label).toBe('github@example.com');
  });
});
