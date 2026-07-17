import pDefer from 'p-defer';
import { describe, expect, it, vi } from 'vitest';

import {
  KimiCodeAuthError,
  KimiCodeSessionCoordinator,
  type KimiCodeOAuthRefreshClient,
  type KimiCodeSession,
  type KimiCodeSessionStorage,
  type KimiCodeTokenResponse,
} from '@auth/kimiCode';

const NOW = 1_900_000_000_000;
const FIVE_MIN = 5 * 60 * 1000;

function memoryStorage(initial?: KimiCodeSession): KimiCodeSessionStorage & {
  peek: () => KimiCodeSession | undefined;
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
    peek: () => (value ? (JSON.parse(value) as KimiCodeSession) : undefined),
  };
}

/**
 * In-memory storage whose first `store`, `delete`, or `get` call blocks until
 * the test calls `release()`, for deterministic race interleavings.
 * `gateReached` resolves once the gated call has started (and is blocked).
 */
function gatedStorage(
  gateOn: 'get' | 'store' | 'delete',
  initial?: KimiCodeSession,
): KimiCodeSessionStorage & {
  peek: () => KimiCodeSession | undefined;
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
    peek: () => (value ? (JSON.parse(value) as KimiCodeSession) : undefined),
    gateReached: reached.promise,
    release: () => released.resolve(),
  };
}

function session(overrides: Partial<KimiCodeSession> = {}): KimiCodeSession {
  return {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAtMs: NOW + 60 * 60 * 1000,
    accountId: 'acct-0',
    ...overrides,
  };
}

function tokenResponse(
  overrides: Partial<KimiCodeTokenResponse> = {},
): KimiCodeTokenResponse {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    ...overrides,
  };
}

function newLoginTokenResponse(): KimiCodeTokenResponse {
  return tokenResponse({
    access_token: 'access-new',
    refresh_token: 'refresh-new',
  });
}

function makeCoordinator(
  storage: KimiCodeSessionStorage,
  client: Partial<KimiCodeOAuthRefreshClient> = {},
): KimiCodeSessionCoordinator {
  return new KimiCodeSessionCoordinator({
    storage,
    client: {
      refreshTokens: vi.fn(),
      ...client,
    },
    now: () => NOW,
  });
}

describe('KimiCodeSessionCoordinator', () => {
  it('reports signed-out with no stored session', async () => {
    const coordinator = makeCoordinator(memoryStorage());
    expect(await coordinator.getStatus()).toEqual({ signedIn: false });
  });

  it('reports signed-in with the account from the stored session', async () => {
    const coordinator = makeCoordinator(memoryStorage(session()));
    expect(await coordinator.getStatus()).toEqual({
      signedIn: true,
      accountId: 'acct-0',
    });
  });

  it('treats non-JSON storage as signed out', async () => {
    const storage = memoryStorage();
    await storage.store('not json {');
    const coordinator = makeCoordinator(storage);
    expect(await coordinator.getStatus()).toEqual({ signedIn: false });
    await expect(coordinator.getFreshAccessToken()).rejects.toMatchObject({
      kind: 'expired',
      needsReauth: true,
    });
  });

  it('treats a bundle that fails validation as signed out', async () => {
    const storage = memoryStorage();
    await storage.store(JSON.stringify({ accessToken: '', refreshToken: 42 }));
    const coordinator = makeCoordinator(storage);
    expect(await coordinator.getStatus()).toEqual({ signedIn: false });
    await expect(coordinator.getFreshAccessToken()).rejects.toMatchObject({
      kind: 'expired',
      needsReauth: true,
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
    expect(refreshTokens).toHaveBeenCalledWith('refresh-0');
    expect(storage.peek()?.accessToken).toBe('access-1');
    expect(storage.peek()?.expiresAtMs).toBe(NOW + 3600 * 1000);
  });

  it('single-flights concurrent refreshes', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW - 1 }));
    const { promise: pending, resolve } = pDefer<KimiCodeTokenResponse>();
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
    const { promise: pending, resolve } = pDefer<KimiCodeTokenResponse>();
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
    const storage = gatedStorage('store', session({ expiresAtMs: NOW - 1 }));
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
    const storage = gatedStorage('delete', session({ expiresAtMs: NOW - 1 }));
    const refreshTokens = vi.fn(async () => {
      throw new KimiCodeAuthError('revoked', 'fatal', 401);
    });
    const coordinator = makeCoordinator(storage, { refreshTokens });

    const token = coordinator.getFreshAccessToken();
    // The fatal refresh has started its delete (blocked); a login lands now.
    await storage.gateReached;
    const login = coordinator.completeDeviceLogin(newLoginTokenResponse());
    // Let the login run as far as it can before the delete unblocks, so an
    // unserialized store would land first and be erased by the stale delete.
    await new Promise((r) => setTimeout(r, 0));
    storage.release();

    await expect(token).rejects.toMatchObject({ kind: 'fatal' });
    await login;
    expect(storage.peek()?.accessToken).toBe('access-new');
    expect(storage.peek()?.refreshToken).toBe('refresh-new');
  });

  it('does not start a stale refresh for a caller entering during sign-out', async () => {
    const storage = gatedStorage('delete', session({ expiresAtMs: NOW - 1 }));
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
    const storage = gatedStorage('store', session({ expiresAtMs: NOW - 1 }));
    const refreshTokens = vi.fn(async () => tokenResponse());
    const coordinator = makeCoordinator(storage, { refreshTokens });

    const login = coordinator.completeDeviceLogin(newLoginTokenResponse());
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
    const coordinator = makeCoordinator(storage);

    const token = coordinator.getFreshAccessToken();
    await storage.gateReached;
    await coordinator.completeDeviceLogin(newLoginTokenResponse());
    storage.release();

    expect(await token).toBe('access-new');
    expect(storage.peek()?.accessToken).toBe('access-new');
  });

  it('does not clear a newer login when a stale refresh is rejected', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW - 1 }));
    const { promise: pending, reject } = pDefer<KimiCodeTokenResponse>();
    const refreshTokens = vi.fn(() => pending);
    const coordinator = makeCoordinator(storage, { refreshTokens });

    const token = coordinator.getFreshAccessToken();
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshTokens).toHaveBeenCalledOnce();

    await coordinator.completeDeviceLogin(newLoginTokenResponse());
    reject(new KimiCodeAuthError('revoked', 'fatal', 401));

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

  it('preserves the accountId across a refresh', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW - 1 }));
    const refreshTokens = vi.fn(async () => tokenResponse());
    const coordinator = makeCoordinator(storage, { refreshTokens });
    await coordinator.getFreshAccessToken();
    expect(storage.peek()?.accountId).toBe('acct-0');
  });

  it('clears the session and surfaces re-auth on a fatal refresh', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW - 1 }));
    const refreshTokens = vi.fn(async () => {
      throw new KimiCodeAuthError('revoked', 'fatal', 401);
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
      throw new KimiCodeAuthError('upstream 502', 'transient', 502);
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

  it('persists the session from a completed device login', async () => {
    const storage = memoryStorage();
    const coordinator = makeCoordinator(storage);

    const stored = await coordinator.completeDeviceLogin(tokenResponse());

    expect(stored).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAtMs: NOW + 3600 * 1000,
      accountId: undefined,
    });
    expect(storage.peek()).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAtMs: NOW + 3600 * 1000,
    });
    expect(await coordinator.getFreshAccessToken()).toBe('access-1');
  });

  it('rejects a device login whose response has no refresh token', async () => {
    const storage = memoryStorage();
    const coordinator = makeCoordinator(storage);
    await expect(
      coordinator.completeDeviceLogin(tokenResponse({ refresh_token: null })),
    ).rejects.toMatchObject({ kind: 'fatal' });
    expect(storage.peek()).toBeUndefined();
  });

  it('signs out by deleting the stored session', async () => {
    const storage = memoryStorage(session());
    const coordinator = makeCoordinator(storage);
    await coordinator.signOut();
    expect(storage.peek()).toBeUndefined();
  });
});
