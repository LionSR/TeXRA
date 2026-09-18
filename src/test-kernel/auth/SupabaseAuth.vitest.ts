// Third-party imports
import { strict as assert } from 'node:assert';
import { Effect } from 'effect';
import { describe, it, afterEach, expect, vi } from 'vitest';

// Local imports - auth
import { SUPABASE_GOTRUE_STORAGE_KEY } from '@auth/config';
import { createSupabaseAuth, type SupabaseAuthShape } from '@auth/SupabaseAuth';
import type { SessionSecretStore } from '@auth/oauth/sessionAccess';
import * as logger from '@logger/logUtils';
import { SecretsFailed } from '@platform/secrets';
import { FakeSecrets } from '@test/support/FakePlatform';

function createAuth(
  secrets: SessionSecretStore,
  whenReady?: () => Promise<void>,
): SupabaseAuthShape {
  return Effect.runSync(
    createSupabaseAuth({ secrets, ...(whenReady ? { whenReady } : {}) }),
  );
}

describe('SupabaseAuth probes', () => {
  it('reports not ready when the readiness gate fails', async () => {
    const auth = createAuth(new FakeSecrets(), () =>
      Promise.reject(new Error('host auth unavailable')),
    );

    assert.equal(await Effect.runPromise(auth.isReady), false);
    assert.equal(auth.getInitError()?.message, 'host auth unavailable');
  });

  it('warns and reports no label when the stored label read throws', async () => {
    const secrets: SessionSecretStore = {
      get: () =>
        Effect.fail(
          new SecretsFailed({
            reason: 'io',
            operation: 'get',
            message: 'secret storage unavailable',
          }),
        ),
      set: () => Effect.void,
      delete: () => Effect.void,
    };
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const auth = createAuth(secrets);

    await expect(Effect.runPromise(auth.storedAccountLabel)).resolves.toBe(
      null,
    );
    expect(warn).toHaveBeenCalledWith(
      'SupabaseAuth',
      expect.stringContaining('secret storage unavailable'),
    );
  });
});

describe('SupabaseAuth PKCE flow state', () => {
  const VERIFIER_KEY = `${SUPABASE_GOTRUE_STORAGE_KEY}-code-verifier`;

  afterEach(() => {
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
  async function startSignIn(auth: SupabaseAuthShape): Promise<void> {
    const { error } = await auth.client.auth.signInWithOAuth({
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
    const auth = createAuth(secrets);

    await startSignIn(auth);

    // A flow start writes its numbered slot, the slot index, and the fixed
    // legacy key the callback reads. All three are keys GoTrue derives from
    // its storage key; the storage key itself is the session slot and must
    // never appear here.
    const keys = await Effect.runPromise(secrets.listStoredKeys());
    assert.ok(keys.includes(VERIFIER_KEY));
    assert.ok(!keys.includes(SUPABASE_GOTRUE_STORAGE_KEY));
    assert.ok(
      keys.every((key) => key.startsWith(`${SUPABASE_GOTRUE_STORAGE_KEY}-`)),
      `unexpected persisted keys: ${keys.join(', ')}`,
    );
  });

  it('completes a callback delivered to a different client instance', async () => {
    const secrets = new FakeSecrets();
    await startSignIn(createAuth(secrets));
    // GoTrue JSON-encodes every stored value; the slot holds the verifier
    // alone, or `verifier/redirectType` for a recovery link.
    const stored: unknown = JSON.parse(
      (await Effect.runPromise(secrets.getStored(VERIFIER_KEY))) ?? '',
    );
    const verifier = String(stored).split('/')[0];
    assert.ok(verifier);

    // A second window (or the same one after a host reload): a fresh client
    // that never generated a verifier of its own.
    const exchangeBody = stubCodeExchange();
    const secondWindow = createAuth(secrets);

    const { data, error } =
      await secondWindow.client.auth.exchangeCodeForSession('auth-code');

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
    const remaining = await Effect.runPromise(secrets.listStoredKeys());
    assert.ok(!remaining.includes(VERIFIER_KEY));
    assert.ok(!remaining.includes(SUPABASE_GOTRUE_STORAGE_KEY));
  });

  it('still signs in this window when the secret store is unwritable', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // A locked keychain answers an absent value (rather than throwing) on
    // reads and throws on writes; only the in-process mirror remains usable.
    const secrets: SessionSecretStore = {
      get: () => Effect.succeed(undefined),
      set: () =>
        Effect.fail(
          new SecretsFailed({
            reason: 'io',
            operation: 'set',
            message: 'keychain locked',
          }),
        ),
      delete: () => Effect.void,
    };
    const auth = createAuth(secrets);

    await startSignIn(auth);

    expect(warn).toHaveBeenCalledWith(
      'SupabaseAuth',
      expect.stringContaining('keychain locked'),
    );

    // The callback lands in this window: the exchange must still succeed
    // using the mirrored verifier even though the store miss returned absent.
    const exchangeBody = stubCodeExchange();

    const { data, error } =
      await auth.client.auth.exchangeCodeForSession('auth-code');

    assert.equal(error, null);
    assert.equal(data.session?.access_token, 'pkce-access');
    assert.ok(
      JSON.parse(exchangeBody()).code_verifier.length > 0,
      'the exchange reused the verifier mirrored in memory',
    );
  });
});
