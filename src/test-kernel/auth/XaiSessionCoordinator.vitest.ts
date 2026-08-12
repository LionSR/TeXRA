import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  XaiAuthError,
  XaiSessionCoordinator,
  type XaiOAuthClient,
  type XaiSession,
  type XaiSessionStorage,
  type XaiTokenResponse,
} from '@auth/xai';
import * as logger from '@logger/logUtils';
import { createDeferred } from '@test/support/asyncTestUtils';

const NOW = 1_900_000_000_000;
const FIVE_MIN = 5 * 60 * 1000;

function memoryStorage(initial?: XaiSession): XaiSessionStorage & {
  peek: () => XaiSession | undefined;
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
    peek: () => (value ? (JSON.parse(value) as XaiSession) : undefined),
  };
}

function session(overrides: Partial<XaiSession> = {}): XaiSession {
  return {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAtMs: NOW + 60 * 60 * 1000,
    email: 'user@x.ai',
    ...overrides,
  };
}

function tokens(overrides: Partial<XaiTokenResponse> = {}): XaiTokenResponse {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    ...overrides,
  };
}

function makeCoordinator(options: {
  storage: XaiSessionStorage;
  client?: XaiOAuthClient;
}): XaiSessionCoordinator {
  return new XaiSessionCoordinator({ ...options, now: () => NOW });
}

describe('XaiSessionCoordinator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buildAuthorizeRequest includes pinned redirect, plan, and referrer', () => {
    const coordinator = makeCoordinator({ storage: memoryStorage() });
    const auth = coordinator.buildAuthorizeRequest(0);
    const url = new URL(auth.url);
    expect(auth.redirectUri).toBe('http://127.0.0.1:56121/callback');
    expect(url.searchParams.get('client_id')).toBe(
      'b1a00492-073a-47ea-816f-4c329264a828',
    );
    expect(url.searchParams.get('redirect_uri')).toBe(auth.redirectUri);
    expect(url.searchParams.get('plan')).toBe('generic');
    expect(url.searchParams.get('referrer')).toBe('texra');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // CSRF is `state`; we do not send an unverified OIDC nonce.
    expect(url.searchParams.get('nonce')).toBeNull();
    expect(auth.verifier.length).toBeGreaterThan(20);
    expect(auth.state.length).toBeGreaterThan(20);
  });

  it.each([
    { stored: '{not-json', warning: 'not valid JSON' },
    {
      stored: JSON.stringify({ accessToken: 'only' }),
      warning: 'schema validation',
    },
  ])(
    'warns and treats an unreadable stored session ($warning) as signed out',
    async ({ stored, warning }) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const storage: XaiSessionStorage = {
        get: async () => stored,
        store: async () => {},
        delete: async () => {},
      };
      const coordinator = makeCoordinator({ storage });
      expect(await coordinator.loadSession()).toBeNull();
      expect(await coordinator.getStatus()).toEqual({ signedIn: false });
      expect(warn).toHaveBeenCalledWith(
        'SubscriptionOAuth',
        expect.stringContaining(warning),
      );
    },
  );

  it('stores a session after code exchange', async () => {
    const storage = memoryStorage();
    const coordinator = makeCoordinator({
      storage,
      client: {
        exchangeAuthorizationCode: vi.fn(async () => tokens()),
        refreshTokens: vi.fn(),
      },
    });
    const stored = await coordinator.completeLoginWithCode({
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'http://127.0.0.1:56121/callback',
    });
    expect(stored.accessToken).toBe('access-1');
    expect(storage.peek()?.refreshToken).toBe('refresh-1');
    expect((await coordinator.getStatus()).signedIn).toBe(true);
  });

  it('refreshes when within the buffer and single-flights concurrent callers', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW + FIVE_MIN - 1 }));
    const refreshDeferred = createDeferred<XaiTokenResponse>();
    const refreshTokens = vi.fn(() => refreshDeferred.promise);
    const coordinator = makeCoordinator({
      storage,
      client: {
        exchangeAuthorizationCode: vi.fn(),
        refreshTokens,
      },
    });

    const a = coordinator.getFreshAccessToken();
    const b = coordinator.getFreshAccessToken();
    // Allow both callers to enter the refresh path before asserting single-flight.
    await vi.waitFor(() => {
      expect(refreshTokens).toHaveBeenCalledTimes(1);
    });
    refreshDeferred.resolve(tokens({ access_token: 'access-fresh' }));
    await expect(a).resolves.toBe('access-fresh');
    await expect(b).resolves.toBe('access-fresh');
  });

  it('clears the session on fatal refresh and throws', async () => {
    const storage = memoryStorage(session({ expiresAtMs: NOW + FIVE_MIN - 1 }));
    const coordinator = makeCoordinator({
      storage,
      client: {
        exchangeAuthorizationCode: vi.fn(),
        refreshTokens: vi.fn(async () => {
          throw new XaiAuthError('revoked', 'fatal', 400);
        }),
      },
    });
    await expect(coordinator.getFreshAccessToken()).rejects.toMatchObject({
      kind: 'fatal',
    });
    expect(storage.peek()).toBeUndefined();
  });

  it('throws expired when not signed in', async () => {
    const coordinator = makeCoordinator({ storage: memoryStorage() });
    await expect(coordinator.getFreshAccessToken()).rejects.toMatchObject({
      kind: 'expired',
    });
  });
});
