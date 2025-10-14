// Standard library imports
import { strict as assert } from 'assert';

// Local imports - module under test
import {
  clearSupabaseSession,
  loadSupabaseSession,
  saveProxySession,
  saveSupabaseSession,
  scheduleRefresh,
} from '@frontend/auth/sessionStorage';
import { SecretManager } from '@frontend/secretManager';

suite('frontend/auth/sessionStorage', () => {
  const originalGet = SecretManager.get.bind(SecretManager);
  const originalSet = SecretManager.set.bind(SecretManager);
  const originalDelete = SecretManager.delete.bind(SecretManager);

  const secrets = new Map<string, string>();

  async function stubGet(key: string): Promise<string | undefined> {
    return secrets.get(key);
  }

  async function stubSet(key: string, value: string): Promise<void> {
    secrets.set(key, value);
  }

  async function stubDelete(key: string): Promise<void> {
    secrets.delete(key);
  }

  setup(() => {
    secrets.clear();
    (SecretManager as any).get = stubGet;
    (SecretManager as any).set = stubSet;
    (SecretManager as any).delete = stubDelete;
  });

  teardown(() => {
    secrets.clear();
    (SecretManager as any).get = originalGet;
    (SecretManager as any).set = originalSet;
    (SecretManager as any).delete = originalDelete;
    delete process.env.SUPABASE_ACCESS_EXPIRES_AT;
  });

  test('saveSupabaseSession persists access and refresh tokens', async () => {
    await saveSupabaseSession({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '2024-01-01T00:00:00.000Z',
    });

    assert.equal(secrets.get('auth.supabase.accessToken'), 'access-token');
    assert.equal(secrets.get('auth.supabase.refreshToken'), 'refresh-token');
  });

  test('loadSupabaseSession reads previously saved values', async () => {
    secrets.set('auth.supabase.accessToken', 'persisted-access');
    secrets.set('auth.supabase.refreshToken', 'persisted-refresh');
    process.env.SUPABASE_ACCESS_EXPIRES_AT = '2030-12-31T00:00:00.000Z';

    const session = await loadSupabaseSession();
    assert(session);
    assert.equal(session?.accessToken, 'persisted-access');
    assert.equal(session?.refreshToken, 'persisted-refresh');
    assert.equal(session?.expiresAt, '2030-12-31T00:00:00.000Z');
  });

  test('clearSupabaseSession removes all stored values', async () => {
    secrets.set('auth.supabase.accessToken', 'keep-me');
    secrets.set('auth.supabase.refreshToken', 'keep-me');
    secrets.set('auth.supabase.proxyToken', 'keep-me');

    await clearSupabaseSession();
    assert.equal(secrets.size, 0);
  });

  test('saveProxySession sets auxiliary proxy metadata', async () => {
    await saveProxySession({
      token: 'proxy-token',
      expiresAt: '2025-05-05T05:05:05.000Z',
      sessionId: 'session-123',
    });

    assert.equal(secrets.get('auth.supabase.proxyToken'), 'proxy-token');
    assert.equal(
      secrets.get('auth.supabase.proxyExpiry'),
      '2025-05-05T05:05:05.000Z',
    );
    assert.equal(secrets.get('auth.supabase.proxySessionId'), 'session-123');
  });

  test('scheduleRefresh executes immediately when expiry elapsed', async () => {
    let triggered = false;
    scheduleRefresh(async () => {
      triggered = true;
    }, '2000-01-01T00:00:00.000Z');

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(triggered, true);
  });
});
