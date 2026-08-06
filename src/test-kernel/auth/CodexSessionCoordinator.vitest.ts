import pDefer from 'p-defer';
import { describe, expect, it, vi } from 'vitest';

import {
  CodexAuthError,
  CodexSessionCoordinator,
  type CodexOAuthClient,
  type CodexSession,
  type CodexSessionStorage,
  type CodexTokenResponse,
} from '@auth/codex';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import { delay } from '@utils/core';

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
  it('reports signed-out with no stored session', async () => {
    const coordinator = makeCoordinator(memoryStorage());
    expect(await coordinator.getStatus()).toEqual({ signedIn: false });
  });

  it('reports signed-in with email/account from the stored session', async () => {
    const coordinator = makeCoordinator(memoryStorage(session()));
    expect(await coordinator.getStatus()).toEqual({
      signedIn: true,
      email: 'user@example.com',
      accountId: 'acct-0',
    });
  });

  it('does not refresh a token outside the 5-minute buffer', async () => {
    const storage = memoryStorage(
      session({ expiresAtMs: NOW + FIVE_MIN + 60_000 }),
    );
    const refreshTokens = vi.fn();
    const coordinator = makeCoordinator(storage, { refreshTokens });
    expect(await coordinator.getFreshAccessToken()).toBe('access-0');
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it('refreshes proactively within the 5-minute buffer', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW + 60_000 }));
    const refreshTokens = vi.fn(async () => tokenResponse());
    const coordinator = makeCoordinator(storage, { refreshTokens });
    expect(await coordinator.getFreshAccessToken()).toBe('access-1');
    expect(refreshTokens).toHaveBeenCalledOnce();
    expect(storage.peek()?.accessToken).toBe('access-1');
  });

  it('single-flights concurrent refreshes', async () => {
    const storage = memoryStorage(expiredSession());
    const { promise: pending, resolve } = pDefer<CodexTokenResponse>();
    const refreshTokens = vi.fn(() => pending);
    const coordinator = makeCoordinator(storage, { refreshTokens });

    const a = coordinator.getFreshAccessToken();
    const b = coordinator.getFreshAccessToken();
    // Let both callers reach the shared refresh before it resolves.
    await delay(0);
    expect(refreshTokens).toHaveBeenCalledOnce();

    resolve(tokenResponse());
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toBe('access-1');
    expect(rb).toBe('access-1');
    expect(refreshTokens).toHaveBeenCalledOnce();
  });

  it('does not restore a session when sign-out races with refresh', async () => {
    const storage = memoryStorage(expiredSession());
    const { promise: pending, resolve } = pDefer<CodexTokenResponse>();
    const refreshTokens = vi.fn(() => pending);
    const coordinator = makeCoordinator(storage, { refreshTokens });

    const token = coordinator.getFreshAccessToken();
    await delay(0);
    expect(refreshTokens).toHaveBeenCalledOnce();

    await coordinator.signOut();
    resolve(tokenResponse());

    await expect(token).rejects.toMatchObject({
      kind: 'expired',
      needsReauth: true,
    });
    expect(storage.peek()).toBeUndefined();
  });

  it('does not restore a session when sign-out races with refresh storage', async () => {
    const storage = gatedStorage('store', expiredSession());
    const refreshTokens = vi.fn(async () => tokenResponse());
    const coordinator = makeCoordinator(storage, { refreshTokens });

    const token = coordinator.getFreshAccessToken();
    await storage.gateReached;
    const signOut = coordinator.signOut();
    storage.release();

    await expect(token).rejects.toMatchObject({
      kind: 'expired',
      needsReauth: true,
    });
    await signOut;
    expect(storage.peek()).toBeUndefined();
  });

  it('does not erase a newer login with a blocked fatal-refresh deletion', async () => {
    const storage = gatedStorage('delete', expiredSession());
    const refreshTokens = vi.fn(async () => {
      throw new CodexAuthError('revoked', 'fatal', 401);
    });
    const exchangeAuthorizationCode = vi.fn(async () =>
      newLoginTokenResponse(),
    );
    const coordinator = makeCoordinator(storage, {
      exchangeAuthorizationCode,
      refreshTokens,
    });

    const token = coordinator.getFreshAccessToken();
    // The fatal refresh has started its delete (blocked); a login lands now.
    await storage.gateReached;
    const login = completeLogin(coordinator);
    // Let the login run as far as it can before the delete unblocks, so an
    // unserialized store would land first and be erased by the stale delete.
    await delay(0);
    storage.release();

    await expect(token).rejects.toMatchObject({ kind: 'fatal' });
    await login;
    expect(storage.peek()?.accessToken).toBe('access-new');
    expect(storage.peek()?.refreshToken).toBe('refresh-new');
  });

  it('does not start a stale refresh for a caller entering during sign-out', async () => {
    const storage = gatedStorage('delete', expiredSession());
    const refreshTokens = vi.fn(async () => tokenResponse());
    const coordinator = makeCoordinator(storage, { refreshTokens });

    const signOut = coordinator.signOut();
    // The sign-out delete is blocked mid-write; a caller enters now.
    await storage.gateReached;
    const token = coordinator.getFreshAccessToken();
    storage.release();

    await expect(token).rejects.toMatchObject({
      kind: 'expired',
      needsReauth: true,
    });
    await signOut;
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(storage.peek()).toBeUndefined();
  });

  it('does not overwrite a newer login for a caller entering during login', async () => {
    const storage = gatedStorage('store', expiredSession());
    const refreshTokens = vi.fn(async () => tokenResponse());
    const exchangeAuthorizationCode = vi.fn(async () =>
      newLoginTokenResponse(),
    );
    const coordinator = makeCoordinator(storage, {
      exchangeAuthorizationCode,
      refreshTokens,
    });

    const login = completeLogin(coordinator);
    // The login store is blocked mid-write; a caller enters now.
    await storage.gateReached;
    const token = coordinator.getFreshAccessToken();
    storage.release();

    await login;
    expect(await token).toBe('access-new');
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(storage.peek()?.accessToken).toBe('access-new');
  });

  it('retries a session read superseded while storage is blocked', async () => {
    const storage = gatedStorage('get', session());
    const exchangeAuthorizationCode = vi.fn(async () =>
      newLoginTokenResponse(),
    );
    const coordinator = makeCoordinator(storage, {
      exchangeAuthorizationCode,
    });

    const token = coordinator.getFreshAccessToken();
    await storage.gateReached;
    await completeLogin(coordinator);
    storage.release();

    expect(await token).toBe('access-new');
    expect(storage.peek()?.accessToken).toBe('access-new');
  });

  it('does not clear a newer login when a stale refresh is rejected', async () => {
    const storage = memoryStorage(expiredSession());
    const { promise: pending, reject } = pDefer<CodexTokenResponse>();
    const refreshTokens = vi.fn(() => pending);
    const exchangeAuthorizationCode = vi.fn(async () =>
      newLoginTokenResponse(),
    );
    const coordinator = makeCoordinator(storage, {
      exchangeAuthorizationCode,
      refreshTokens,
    });

    const token = coordinator.getFreshAccessToken();
    await delay(0);
    expect(refreshTokens).toHaveBeenCalledOnce();

    await completeLogin(coordinator);
    reject(new CodexAuthError('revoked', 'fatal', 401));

    await expect(token).rejects.toMatchObject({
      kind: 'fatal',
      needsReauth: true,
    });
    expect(storage.peek()?.accessToken).toBe('access-new');
    expect(storage.peek()?.refreshToken).toBe('refresh-new');
  });

  it('returns the newer login when a successful refresh is superseded', async () => {
    const storage = memoryStorage(expiredSession());
    const { promise: pending, resolve } = pDefer<CodexTokenResponse>();
    const refreshTokens = vi.fn(() => pending);
    const exchangeAuthorizationCode = vi.fn(async () =>
      newLoginTokenResponse(),
    );
    const coordinator = makeCoordinator(storage, {
      exchangeAuthorizationCode,
      refreshTokens,
    });

    const token = coordinator.getFreshAccessToken();
    await delay(0);
    expect(refreshTokens).toHaveBeenCalledOnce();

    await completeLogin(coordinator);
    resolve(tokenResponse());

    // Concurrent sign-in is not a re-auth failure — hand back the new session.
    await expect(token).resolves.toBe('access-new');
    expect(storage.peek()?.accessToken).toBe('access-new');
    expect(storage.peek()?.refreshToken).toBe('refresh-new');
  });

  it('does not treat a still-expiring pre-refresh session as a successful supersede', async () => {
    // Generation bump that leaves the same expiring credentials (models a
    // concurrent store that failed after supersede, or rewrote the same
    // blob) must not hand back the stale token as if refresh completed.
    const storage = memoryStorage(expiredSession());
    const { promise: pending, resolve } = pDefer<CodexTokenResponse>();
    const refreshTokens = vi.fn(() => pending);
    const exchangeAuthorizationCode = vi.fn(async () =>
      tokenResponse({
        access_token: 'access-0',
        refresh_token: 'refresh-0',
        // Still inside the proactive refresh buffer.
        expires_in: 60,
      }),
    );
    const coordinator = makeCoordinator(storage, {
      exchangeAuthorizationCode,
      refreshTokens,
    });

    const token = coordinator.getFreshAccessToken();
    await delay(0);
    expect(refreshTokens).toHaveBeenCalledOnce();

    await completeLogin(coordinator);
    resolve(tokenResponse({ access_token: 'access-stale-refresh' }));

    await expect(token).rejects.toMatchObject({
      kind: 'transient',
      needsReauth: false,
    });
    expect(storage.peek()?.accessToken).toBe('access-0');
  });

  it('keeps the previous refresh token when the response omits a new one', async () => {
    const storage = memoryStorage(expiredSession());
    const refreshTokens = vi.fn(async () =>
      tokenResponse({ refresh_token: undefined }),
    );
    const coordinator = makeCoordinator(storage, { refreshTokens });
    await coordinator.getFreshAccessToken();
    expect(storage.peek()?.refreshToken).toBe('refresh-0');
  });

  it('clears the session and surfaces re-auth on a fatal refresh', async () => {
    const storage = memoryStorage(expiredSession());
    const refreshTokens = vi.fn(async () => {
      throw new CodexAuthError('revoked', 'fatal', 401);
    });
    const coordinator = makeCoordinator(storage, { refreshTokens });

    await expect(coordinator.getFreshAccessToken()).rejects.toMatchObject({
      kind: 'fatal',
      needsReauth: true,
    });
    expect(storage.peek()).toBeUndefined();
  });

  it('keeps the session on a transient refresh failure', async () => {
    const storage = memoryStorage(expiredSession());
    const refreshTokens = vi.fn(async () => {
      throw new CodexAuthError('upstream 502', 'transient', 502);
    });
    const coordinator = makeCoordinator(storage, { refreshTokens });

    await expect(coordinator.getFreshAccessToken()).rejects.toMatchObject({
      kind: 'transient',
    });
    expect(storage.peek()?.refreshToken).toBe('refresh-0');
  });

  it('throws expired when not signed in', async () => {
    const coordinator = makeCoordinator(memoryStorage());
    await expect(coordinator.getFreshAccessToken()).rejects.toMatchObject({
      kind: 'expired',
      needsReauth: true,
    });
  });

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

  it('signs out by deleting the stored session', async () => {
    const storage = memoryStorage(session());
    const coordinator = makeCoordinator(storage);
    await coordinator.signOut();
    expect(storage.peek()).toBeUndefined();
  });
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
