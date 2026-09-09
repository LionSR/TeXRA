// Node imports
import { setTimeout as delay } from 'node:timers/promises';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit } from 'effect';
import pDefer from 'p-defer';
import { describe, expect, vi } from 'vitest';

// Local imports
import {
  CodexAuthError,
  type CodexOAuthClient,
  type CodexSessionStorage,
} from '@auth/codex';
import { CodexSessionCoordinator } from '@auth/codex/CodexSessionCoordinator';
import type {
  CodexSession,
  CodexTokenResponse,
} from '@auth/codex/codexSessionTypes';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import { effectRuntime } from '@platform/processRuntime';

const NOW = 1_900_000_000_000;
const FIVE_MIN = 5 * 60 * 1000;

function memoryStorage(initial?: CodexSession): CodexSessionStorage & {
  peek: () => CodexSession | undefined;
} {
  let value = initial ? JSON.stringify(initial) : undefined;
  return {
    get: async () => value,
    store: async (v) => {
      value = v;
    },
    delete: async () => {
      value = undefined;
    },
    peek: () => (value ? (JSON.parse(value) as CodexSession) : undefined),
  };
}

/**
 * In-memory storage whose first `store` or `delete` call blocks until the
 * test calls `release()`, for deterministic race interleavings. `gateReached`
 * resolves once the gated write has started (and is therefore blocked).
 */
function gatedStorage(
  gateOn: 'get' | 'store' | 'delete',
  initial?: CodexSession,
): CodexSessionStorage & {
  peek: () => CodexSession | undefined;
  gateReached: Promise<void>;
  release: () => void;
} {
  let value = initial ? JSON.stringify(initial) : undefined;
  const reached = pDefer<void>();
  const released = pDefer<void>();
  let gated = true;
  const gate = async () => {
    if (!gated) return;
    gated = false;
    reached.resolve();
    await released.promise;
  };
  return {
    get: async () => {
      const snapshot = value;
      if (gateOn === 'get') await gate();
      return snapshot;
    },
    store: async (v) => {
      if (gateOn === 'store') await gate();
      value = v;
    },
    delete: async () => {
      if (gateOn === 'delete') await gate();
      value = undefined;
    },
    peek: () => (value ? (JSON.parse(value) as CodexSession) : undefined),
    gateReached: reached.promise,
    release: () => released.resolve(),
  };
}

function session(overrides: Partial<CodexSession> = {}): CodexSession {
  return {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAtMs: NOW + 60 * 60 * 1000,
    accountId: 'acct-0',
    email: 'user@example.com',
    ...overrides,
  };
}

function expiredSession(): CodexSession {
  return session({ expiresAtMs: NOW - 1 });
}

function tokenResponse(
  overrides: Partial<CodexTokenResponse> = {},
): CodexTokenResponse {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    ...overrides,
  };
}

function newLoginTokenResponse(): CodexTokenResponse {
  return tokenResponse({
    access_token: 'access-new',
    refresh_token: 'refresh-new',
  });
}

function completeLogin(
  coordinator: CodexSessionCoordinator,
): Promise<CodexSession> {
  return coordinator.completeLoginWithCode({
    code: 'new-code',
    verifier: 'new-verifier',
    redirectUri: 'http://localhost:1455/auth/callback',
  });
}

/**
 * Capture the rejection of a coordinator call the test already started.
 * (`Effect.promise` would turn the rejection into a defect, which
 * `Effect.flip` does not see.)
 */
const rejection = (completion: Promise<unknown>) =>
  Effect.flip(
    Effect.tryPromise({
      try: () => completion,
      catch: (error) => error,
    }),
  );

function makeCoordinator(
  storage: CodexSessionStorage,
  client: Partial<CodexOAuthClient> = {},
): CodexSessionCoordinator {
  return new CodexSessionCoordinator({
    storage,
    client: {
      exchangeAuthorizationCode: vi.fn(),
      refreshTokens: vi.fn(),
      ...client,
    },
    now: () => NOW,
  });
}

describe('CodexSessionCoordinator', () => {
  it.effect('reports signed-out with no stored session', () =>
    Effect.gen(function* () {
      const coordinator = makeCoordinator(memoryStorage());
      expect(yield* Effect.promise(() => coordinator.getStatus())).toEqual({
        signedIn: false,
      });
    }),
  );

  it.effect(
    'reports signed-in with email/account from the stored session',
    () =>
      Effect.gen(function* () {
        const coordinator = makeCoordinator(memoryStorage(session()));
        expect(yield* Effect.promise(() => coordinator.getStatus())).toEqual({
          signedIn: true,
          email: 'user@example.com',
          accountId: 'acct-0',
        });
      }),
  );

  it.effect('does not refresh a token outside the 5-minute buffer', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(
        session({ expiresAtMs: NOW + FIVE_MIN + 60_000 }),
      );
      const refreshTokens = vi.fn();
      const coordinator = makeCoordinator(storage, { refreshTokens });
      expect(
        yield* Effect.promise(() => coordinator.getFreshAccessToken()),
      ).toBe('access-0');
      expect(refreshTokens).not.toHaveBeenCalled();
    }),
  );

  it.effect('refreshes proactively within the 5-minute buffer', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(session({ expiresAtMs: NOW + 60_000 }));
      const refreshTokens = vi.fn(() => Effect.succeed(tokenResponse()));
      const coordinator = makeCoordinator(storage, { refreshTokens });
      expect(
        yield* Effect.promise(() => coordinator.getFreshAccessToken()),
      ).toBe('access-1');
      expect(refreshTokens).toHaveBeenCalledOnce();
      expect(storage.peek()?.accessToken).toBe('access-1');
    }),
  );

  it.effect('single-flights concurrent refreshes', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(expiredSession());
      const pending = Deferred.makeUnsafe<CodexTokenResponse, CodexAuthError>();
      const refreshTokens = vi.fn(() => Deferred.await(pending));
      const coordinator = makeCoordinator(storage, { refreshTokens });

      const a = coordinator.getFreshAccessToken();
      const b = coordinator.getFreshAccessToken();
      // Let both callers reach the shared refresh before it resolves.
      yield* Effect.promise(() => delay(0));
      expect(refreshTokens).toHaveBeenCalledOnce();

      Deferred.doneUnsafe(pending, Effect.succeed(tokenResponse()));
      const [ra, rb] = yield* Effect.promise(() => Promise.all([a, b]));

      expect(ra).toBe('access-1');
      expect(rb).toBe('access-1');
      expect(refreshTokens).toHaveBeenCalledOnce();
    }),
  );

  it.effect('does not restore a session when sign-out races with refresh', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(expiredSession());
      const pending = Deferred.makeUnsafe<CodexTokenResponse, CodexAuthError>();
      const refreshTokens = vi.fn(() => Deferred.await(pending));
      const coordinator = makeCoordinator(storage, { refreshTokens });

      const token = coordinator.getFreshAccessToken();
      yield* Effect.promise(() => delay(0));
      expect(refreshTokens).toHaveBeenCalledOnce();

      yield* Effect.promise(() => coordinator.signOut());
      Deferred.doneUnsafe(pending, Effect.succeed(tokenResponse()));

      const error = yield* rejection(token);
      expect(error).toMatchObject({
        kind: 'expired',
        needsReauth: true,
      });
      expect(storage.peek()).toBeUndefined();
    }),
  );

  it.effect(
    'does not restore a session when sign-out races with refresh storage',
    () =>
      Effect.gen(function* () {
        const storage = gatedStorage('store', expiredSession());
        const refreshTokens = vi.fn(() => Effect.succeed(tokenResponse()));
        const coordinator = makeCoordinator(storage, { refreshTokens });

        const token = coordinator.getFreshAccessToken();
        yield* Effect.promise(() => storage.gateReached);
        const signOut = coordinator.signOut();
        storage.release();

        const error = yield* rejection(token);
        expect(error).toMatchObject({
          kind: 'expired',
          needsReauth: true,
        });
        yield* Effect.promise(() => signOut);
        expect(storage.peek()).toBeUndefined();
      }),
  );

  it.effect(
    'does not erase a newer login with a blocked fatal-refresh deletion',
    () =>
      Effect.gen(function* () {
        const storage = gatedStorage('delete', expiredSession());
        const refreshTokens = vi.fn(() =>
          Effect.fail(new CodexAuthError('revoked', 'fatal', 401)),
        );
        const exchangeAuthorizationCode = vi.fn(() =>
          Effect.succeed(newLoginTokenResponse()),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
          refreshTokens,
        });

        const token = coordinator.getFreshAccessToken();
        // The fatal refresh has started its delete (blocked); a login lands now.
        yield* Effect.promise(() => storage.gateReached);
        const login = completeLogin(coordinator);
        // Let the login run as far as it can before the delete unblocks, so an
        // unserialized store would land first and be erased by the stale delete.
        yield* Effect.promise(() => delay(0));
        storage.release();

        const error = yield* rejection(token);
        expect(error).toMatchObject({ kind: 'fatal' });
        yield* Effect.promise(() => login);
        expect(storage.peek()?.accessToken).toBe('access-new');
        expect(storage.peek()?.refreshToken).toBe('refresh-new');
      }),
  );

  it.effect(
    'does not start a stale refresh for a caller entering during sign-out',
    () =>
      Effect.gen(function* () {
        const storage = gatedStorage('delete', expiredSession());
        const refreshTokens = vi.fn(() => Effect.succeed(tokenResponse()));
        const coordinator = makeCoordinator(storage, { refreshTokens });

        const signOut = coordinator.signOut();
        // The sign-out delete is blocked mid-write; a caller enters now.
        yield* Effect.promise(() => storage.gateReached);
        const token = coordinator.getFreshAccessToken();
        storage.release();

        const error = yield* rejection(token);
        expect(error).toMatchObject({
          kind: 'expired',
          needsReauth: true,
        });
        yield* Effect.promise(() => signOut);
        expect(refreshTokens).not.toHaveBeenCalled();
        expect(storage.peek()).toBeUndefined();
      }),
  );

  it.effect(
    'does not overwrite a newer login for a caller entering during login',
    () =>
      Effect.gen(function* () {
        const storage = gatedStorage('store', expiredSession());
        const refreshTokens = vi.fn(() => Effect.succeed(tokenResponse()));
        const exchangeAuthorizationCode = vi.fn(() =>
          Effect.succeed(newLoginTokenResponse()),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
          refreshTokens,
        });

        const login = completeLogin(coordinator);
        // The login store is blocked mid-write; a caller enters now.
        yield* Effect.promise(() => storage.gateReached);
        const token = coordinator.getFreshAccessToken();
        storage.release();

        yield* Effect.promise(() => login);
        expect(yield* Effect.promise(() => token)).toBe('access-new');
        expect(refreshTokens).not.toHaveBeenCalled();
        expect(storage.peek()?.accessToken).toBe('access-new');
      }),
  );

  it.effect(
    'finishes an interrupted login store before a later sign-out runs',
    () =>
      Effect.gen(function* () {
        const gated = gatedStorage('store');
        const ops: string[] = [];
        const storage: CodexSessionStorage = {
          get: gated.get,
          store: async (value) => {
            ops.push('store');
            await gated.store(value);
          },
          delete: async () => {
            ops.push('delete');
            await gated.delete();
          },
        };
        const exchangeAuthorizationCode = vi.fn(() =>
          Effect.succeed(newLoginTokenResponse()),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
        });
        const controller = new AbortController();

        // The loopback login's run boundary: the host signal interrupts the
        // login's fiber while its session store is blocked mid-write.
        const login = effectRuntime().runPromiseExit(
          coordinator.loginWithCode({
            code: 'new-code',
            verifier: 'new-verifier',
            redirectUri: 'http://localhost:1455/auth/callback',
          }),
          { signal: controller.signal },
        );
        yield* Effect.promise(() => gated.gateReached);
        controller.abort();
        const signOut = coordinator.signOut();
        yield* Effect.promise(() => delay(0));

        // The store cannot be cancelled, so it keeps the permit: the sign-out
        // queues behind it instead of running beside it.
        expect(ops).toEqual(['store']);
        gated.release();

        const loginExit = yield* Effect.promise(() => login);
        expect(Exit.isSuccess(loginExit)).toBe(false);
        yield* Effect.promise(() => signOut);
        expect(ops).toEqual(['store', 'delete']);
        expect(gated.peek()).toBeUndefined();
      }),
  );

  it.effect('retries a session read superseded while storage is blocked', () =>
    Effect.gen(function* () {
      const storage = gatedStorage('get', session());
      const exchangeAuthorizationCode = vi.fn(() =>
        Effect.succeed(newLoginTokenResponse()),
      );
      const coordinator = makeCoordinator(storage, {
        exchangeAuthorizationCode,
      });

      const token = coordinator.getFreshAccessToken();
      yield* Effect.promise(() => storage.gateReached);
      yield* Effect.promise(() => completeLogin(coordinator));
      storage.release();

      expect(yield* Effect.promise(() => token)).toBe('access-new');
      expect(storage.peek()?.accessToken).toBe('access-new');
    }),
  );

  it.effect(
    'does not clear a newer login when a stale refresh is rejected',
    () =>
      Effect.gen(function* () {
        const storage = memoryStorage(expiredSession());
        const pending = Deferred.makeUnsafe<
          CodexTokenResponse,
          CodexAuthError
        >();
        const refreshTokens = vi.fn(() => Deferred.await(pending));
        const exchangeAuthorizationCode = vi.fn(() =>
          Effect.succeed(newLoginTokenResponse()),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
          refreshTokens,
        });

        const token = coordinator.getFreshAccessToken();
        yield* Effect.promise(() => delay(0));
        expect(refreshTokens).toHaveBeenCalledOnce();

        yield* Effect.promise(() => completeLogin(coordinator));
        Deferred.doneUnsafe(
          pending,
          Effect.fail(new CodexAuthError('revoked', 'fatal', 401)),
        );

        const error = yield* rejection(token);
        expect(error).toMatchObject({
          kind: 'fatal',
          needsReauth: true,
        });
        expect(storage.peek()?.accessToken).toBe('access-new');
        expect(storage.peek()?.refreshToken).toBe('refresh-new');
      }),
  );

  it.effect(
    'returns the newer login when a successful refresh is superseded',
    () =>
      Effect.gen(function* () {
        const storage = memoryStorage(expiredSession());
        const pending = Deferred.makeUnsafe<
          CodexTokenResponse,
          CodexAuthError
        >();
        const refreshTokens = vi.fn(() => Deferred.await(pending));
        const exchangeAuthorizationCode = vi.fn(() =>
          Effect.succeed(newLoginTokenResponse()),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
          refreshTokens,
        });

        const token = coordinator.getFreshAccessToken();
        yield* Effect.promise(() => delay(0));
        expect(refreshTokens).toHaveBeenCalledOnce();

        yield* Effect.promise(() => completeLogin(coordinator));
        Deferred.doneUnsafe(pending, Effect.succeed(tokenResponse()));

        // Concurrent sign-in is not a re-auth failure — hand back the new session.
        expect(yield* Effect.promise(() => token)).toBe('access-new');
        expect(storage.peek()?.accessToken).toBe('access-new');
        expect(storage.peek()?.refreshToken).toBe('refresh-new');
      }),
  );

  it.effect(
    'does not treat a still-expiring pre-refresh session as a successful supersede',
    () =>
      Effect.gen(function* () {
        // Generation bump that leaves the same expiring credentials (models a
        // concurrent store that failed after supersede, or rewrote the same
        // blob) must not hand back the stale token as if refresh completed.
        const storage = memoryStorage(expiredSession());
        const pending = Deferred.makeUnsafe<
          CodexTokenResponse,
          CodexAuthError
        >();
        const refreshTokens = vi.fn(() => Deferred.await(pending));
        const exchangeAuthorizationCode = vi.fn(() =>
          Effect.succeed(
            tokenResponse({
              access_token: 'access-0',
              refresh_token: 'refresh-0',
              // Still inside the proactive refresh buffer.
              expires_in: 60,
            }),
          ),
        );
        const coordinator = makeCoordinator(storage, {
          exchangeAuthorizationCode,
          refreshTokens,
        });

        const token = coordinator.getFreshAccessToken();
        yield* Effect.promise(() => delay(0));
        expect(refreshTokens).toHaveBeenCalledOnce();

        yield* Effect.promise(() => completeLogin(coordinator));
        Deferred.doneUnsafe(
          pending,
          Effect.succeed(
            tokenResponse({ access_token: 'access-stale-refresh' }),
          ),
        );

        const error = yield* rejection(token);
        expect(error).toMatchObject({
          kind: 'transient',
          needsReauth: false,
        });
        expect(storage.peek()?.accessToken).toBe('access-0');
      }),
  );

  it.effect(
    'keeps the previous refresh token when the response omits a new one',
    () =>
      Effect.gen(function* () {
        const storage = memoryStorage(expiredSession());
        const refreshTokens = vi.fn(() =>
          Effect.succeed(tokenResponse({ refresh_token: undefined })),
        );
        const coordinator = makeCoordinator(storage, { refreshTokens });
        yield* Effect.promise(() => coordinator.getFreshAccessToken());
        expect(storage.peek()?.refreshToken).toBe('refresh-0');
      }),
  );

  it.effect('clears the session and surfaces re-auth on a fatal refresh', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(expiredSession());
      const refreshTokens = vi.fn(() =>
        Effect.fail(new CodexAuthError('revoked', 'fatal', 401)),
      );
      const coordinator = makeCoordinator(storage, { refreshTokens });

      const error = yield* rejection(coordinator.getFreshAccessToken());
      expect(error).toMatchObject({
        kind: 'fatal',
        needsReauth: true,
      });
      expect(storage.peek()).toBeUndefined();
    }),
  );

  it.effect('keeps the session on a transient refresh failure', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(expiredSession());
      const refreshTokens = vi.fn(() =>
        Effect.fail(new CodexAuthError('upstream 502', 'transient', 502)),
      );
      const coordinator = makeCoordinator(storage, { refreshTokens });

      const error = yield* rejection(coordinator.getFreshAccessToken());
      expect(error).toMatchObject({
        kind: 'transient',
      });
      expect(storage.peek()?.refreshToken).toBe('refresh-0');
    }),
  );

  it.effect('throws expired when not signed in', () =>
    Effect.gen(function* () {
      const coordinator = makeCoordinator(memoryStorage());
      const error = yield* rejection(coordinator.getFreshAccessToken());
      expect(error).toMatchObject({
        kind: 'expired',
        needsReauth: true,
      });
    }),
  );

  it('builds an authorize request with the required PKCE + Codex params', () => {
    const coordinator = makeCoordinator(memoryStorage());
    const req = coordinator.buildAuthorizeRequest(1455);
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe(
      'https://auth.openai.com/oauth/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe(
      'app_EMoamEEZ73f0CkXaXp7hrann',
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:1455/auth/callback',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('originator')).toBe('texra');
    expect(url.searchParams.get('state')).toBe(req.state);
    expect(req.verifier.length).toBeGreaterThan(0);
  });

  it.effect('signs out by deleting the stored session', () =>
    Effect.gen(function* () {
      const storage = memoryStorage(session());
      const coordinator = makeCoordinator(storage);
      yield* Effect.promise(() => coordinator.signOut());
      expect(storage.peek()).toBeUndefined();
    }),
  );
});

describe('codexAccountLabel', () => {
  it('prefers the email, then the account id, then a descriptive fallback', () => {
    expect(
      codexAccountLabel({ email: 'person@example.com', accountId: 'acct-1' }),
    ).toBe('person@example.com');
    expect(codexAccountLabel({ accountId: 'acct-1' })).toBe('acct-1');
    expect(codexAccountLabel({})).toBe('your ChatGPT account');
  });

  it('treats a null wire payload the same as an absent one', () => {
    expect(codexAccountLabel({ email: null, accountId: null })).toBe(
      'your ChatGPT account',
    );
    expect(codexAccountLabel(null)).toBe('your ChatGPT account');
  });
});
