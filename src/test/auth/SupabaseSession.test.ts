// Standard library imports
import { strict as assert } from 'assert';

// Local imports - auth
import {
  DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
  parseStoredSupabaseSession,
  toStorableSupabaseSession,
  type SupabaseSession,
} from '@auth/SupabaseSession';

// Third-party imports
import type { Session as SupabaseNativeSession } from '@supabase/supabase-js';

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
        expiresAt: 123_000,
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
});
