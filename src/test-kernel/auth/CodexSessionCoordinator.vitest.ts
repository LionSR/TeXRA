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
    const storage = memoryStorage(session({ expiresAtMs: NOW - 1 }));
    const { promise: pending, resolve } = pDefer<CodexTokenResponse>();
    const refreshTokens = vi.fn(() => pending);
    const coordinator = makeCoordinator(storage, { refreshTokens });

    const a = coordinator.getFreshAccessToken();
    const b = coordinator.getFreshAccessToken();
    // Let both callers reach the shared refresh before it resolves.
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshTokens).toHaveBeenCalledOnce();

    resolve(tokenResponse());
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toBe('access-1');
    expect(rb).toBe('access-1');
    expect(refreshTokens).toHaveBeenCalledOnce();
  });

  it('does not restore a session when sign-out races with refresh', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW - 1 }));
    const { promise: pending, resolve } = pDefer<CodexTokenResponse>();
    const refreshTokens = vi.fn(() => pending);
    const coordinator = makeCoordinator(storage, { refreshTokens });

    const token = coordinator.getFreshAccessToken();
    await new Promise((r) => setTimeout(r, 0));
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
    let value: string | undefined = JSON.stringify(
      session({ expiresAtMs: NOW - 1 }),
    );
    let storeStarted!: () => void;
    let releaseStore!: () => void;
    const storeStartedPromise = new Promise<void>((resolve) => {
      storeStarted = resolve;
    });
    const releaseStorePromise = new Promise<void>((resolve) => {
      releaseStore = resolve;
    });
    const storage: CodexSessionStorage & {
      peek: () => CodexSession | undefined;
    } = {
      get: async () => value,
      store: async (v) => {
        storeStarted();
        await releaseStorePromise;
        value = v;
      },
      delete: async () => {
        value = undefined;
      },
      peek: () => (value ? (JSON.parse(value) as CodexSession) : undefined),
    };
    const refreshTokens = vi.fn(async () => tokenResponse());
    const coordinator = makeCoordinator(storage, { refreshTokens });

    const token = coordinator.getFreshAccessToken();
    await storeStartedPromise;
    const signOut = coordinator.signOut();
    releaseStore();

    await expect(token).rejects.toMatchObject({
      kind: 'expired',
      needsReauth: true,
    });
    await signOut;
    expect(storage.peek()).toBeUndefined();
  });

  it('does not clear a newer login when a stale refresh is rejected', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW - 1 }));
    const { promise: pending, reject } = pDefer<CodexTokenResponse>();
    const refreshTokens = vi.fn(() => pending);
    const exchangeAuthorizationCode = vi.fn(async () =>
      tokenResponse({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
      }),
    );
    const coordinator = makeCoordinator(storage, {
      exchangeAuthorizationCode,
      refreshTokens,
    });

    const token = coordinator.getFreshAccessToken();
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshTokens).toHaveBeenCalledOnce();

    await coordinator.completeLoginWithCode({
      code: 'new-code',
      verifier: 'new-verifier',
      redirectUri: 'http://localhost:1455/auth/callback',
    });
    reject(new CodexAuthError('revoked', 'fatal', 401));

    await expect(token).rejects.toMatchObject({
      kind: 'fatal',
      needsReauth: true,
    });
    expect(storage.peek()?.accessToken).toBe('access-new');
    expect(storage.peek()?.refreshToken).toBe('refresh-new');
  });

  it('keeps the previous refresh token when the response omits a new one', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW - 1 }));
    const refreshTokens = vi.fn(async () =>
      tokenResponse({ refresh_token: undefined }),
    );
    const coordinator = makeCoordinator(storage, { refreshTokens });
    await coordinator.getFreshAccessToken();
    expect(storage.peek()?.refreshToken).toBe('refresh-0');
  });

  it('clears the session and surfaces re-auth on a fatal refresh', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW - 1 }));
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
    const storage = memoryStorage(session({ expiresAtMs: NOW - 1 }));
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
