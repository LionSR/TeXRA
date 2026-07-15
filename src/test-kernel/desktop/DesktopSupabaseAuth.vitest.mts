import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProfileMessage } from '@controllers/settingsView/ProfileMessageBuilder';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import * as agentRegistry from '@agent/index/agentRegistry';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { SupabaseSession } from '@auth/SupabaseSession';
import { setServerSideKeyService } from '@auth/serverKeys';
import {
  createDesktopProtocolCallbackRouter,
  parseDesktopProtocolCallback,
} from '@desktop/main/desktopProtocolCallbacks';
import {
  createDesktopAuthCallbackState,
  createDesktopSupabaseAuth,
  type DesktopAuthCallbackState,
  type DesktopAuthHost,
  type DesktopOAuthClient,
  type DesktopSupabaseAuthOptions,
} from '@desktop/main/desktopSupabaseAuth';
import type { StateStore } from '@platform/interfaces';

function createCoordinator() {
  const storedSession: { current: SupabaseSession | null } = { current: null };
  return {
    loadSession: vi.fn(async () => storedSession.current),
    storeSession: vi.fn(async (session: SupabaseSession) => {
      storedSession.current = session;
    }),
    clearSession: vi.fn(async () => {
      storedSession.current = null;
    }),
    createSessionFromCallback: vi.fn(async () => callbackSessionResult()),
    whenReady: vi.fn(async () => {}),
    ensureFreshToken: vi.fn(
      async () => storedSession.current?.accessToken ?? null,
    ),
    getSessionTokens: vi.fn(async () =>
      storedSession.current
        ? {
            accessToken: storedSession.current.accessToken,
            refreshToken: storedSession.current.refreshToken,
          }
        : null,
    ),
  };
}

function createLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function callbackSessionResult() {
  return {
    success: true as const,
    session: {
      id: 'user-1',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      account: { id: 'user-1', label: 'user@example.com' },
      expiresAt: Date.now() + 60_000,
    },
  };
}

function createStateStore(): Pick<StateStore, 'get' | 'update'> {
  const state = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue?: T): T {
      return state.has(key) ? (state.get(key) as T) : (defaultValue as T);
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value == null) {
        state.delete(key);
      } else {
        state.set(key, value);
      }
    },
  };
}

function createOAuthClient() {
  type SignInInput = Parameters<
    DesktopOAuthClient['auth']['signInWithOAuth']
  >[0];
  return {
    auth: {
      signInWithOAuth: vi.fn(async (_input: SignInInput) => ({
        data: { url: 'https://auth.example.test/start' },
        error: null,
      })),
    },
  };
}

function createAuthHost(
  overrides: Partial<DesktopAuthHost> = {},
): DesktopAuthHost {
  return {
    openExternalUrl: vi.fn(async () => {}),
    showInfoMessage: vi.fn(async () => {}),
    showErrorMessage: vi.fn(async () => {}),
    onSessionChanged: vi.fn(async () => {}),
    ...overrides,
  };
}

function createAuthOptions(
  overrides: Partial<DesktopSupabaseAuthOptions> = {},
): DesktopSupabaseAuthOptions {
  return {
    router: createDesktopProtocolCallbackRouter(),
    coordinator: createCoordinator(),
    callbackState: createDesktopAuthCallbackState(),
    oauthClient: createOAuthClient(),
    host: createAuthHost(),
    log: createLog(),
    ...overrides,
  };
}

function authCallbackUrl(input: {
  accessToken: string;
  refreshToken: string;
  nonce?: string;
}): string {
  const fragment = new URLSearchParams({
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
  });
  const query = input.nonce ? `?app_nonce=${input.nonce}` : '';
  return `texra://texra-ai.texra/auth-callback${query}#${fragment}`;
}

/** Extract the app_nonce that signIn placed on its OAuth redirect_to. */
function nonceFor(oauthClient: ReturnType<typeof createOAuthClient>): string {
  const call = oauthClient.auth.signInWithOAuth.mock.calls.at(-1)?.[0];
  const redirectTo = call?.options?.redirectTo ?? '';
  const callback = parseDesktopProtocolCallback(redirectTo);
  return new URLSearchParams(callback?.query).get('app_nonce') ?? '';
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function installAuthenticatedSupabaseProvider() {
  const ensureFreshToken = vi.fn(async () => 'fresh-access-token');
  SupabaseClient.initialize('https://example.supabase.co', 'public-key');
  SupabaseClient.setAuthProvider({
    whenReady: vi.fn(async () => {}),
    ensureFreshToken,
    getSessionTokens: vi.fn(async () => ({
      accessToken: 'fresh-access-token',
      refreshToken: 'refresh-token',
    })),
  });
  vi.spyOn(SupabaseClient, 'getUser').mockResolvedValue({
    id: 'user-1',
    email: 'user@example.com',
  } as never);
  vi.spyOn(SupabaseClient, 'getUserAuthContext').mockResolvedValue({
    tier: 'free',
    permissions: ['public'],
  });
  return { ensureFreshToken };
}

describe('desktop Supabase auth', () => {
  beforeEach(() => {
    vi.spyOn(
      agentRegistry,
      'invalidateRemoteAgentsAfterSignOut',
    ).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    SupabaseClient.resetForTests();
  });

  it('opens Supabase OAuth with the desktop texra callback URI', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const oauthClient = createOAuthClient();
    const openExternalUrl = vi.fn(async () => {});
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({
        router,
        coordinator,
        oauthClient,
        host: createAuthHost({ openExternalUrl }),
      }),
    );

    await auth.signIn();

    expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'github',
      options: {
        redirectTo: expect.stringMatching(
          /^texra:\/\/texra-ai\.texra\/auth-callback\?app_nonce=[0-9a-f]{32}$/,
        ),
      },
    });
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://auth.example.test/start',
    );
    auth.dispose();
  });

  it('persists the nonce before sending it to Supabase', async () => {
    const events: string[] = [];
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const callbackState: DesktopAuthCallbackState = {
      hasPendingSignIn: vi.fn(() => false),
      beginAuthAttempt: vi.fn(async () => {
        events.push('begin');
      }),
      matchesPendingNonce: vi.fn(() => false),
      clearAwaitingCallback: vi.fn(async () => {
        events.push('clear');
      }),
    };
    const oauthClient: DesktopOAuthClient = {
      auth: {
        signInWithOAuth: vi.fn(async () => {
          events.push('oauth');
          return {
            data: { url: 'https://auth.example.test/start' },
            error: null,
          };
        }),
      },
    };
    const openExternalUrl = vi.fn(async () => {
      events.push('open');
    });
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({
        router,
        coordinator,
        oauthClient,
        callbackState,
        host: createAuthHost({ openExternalUrl }),
      }),
    );

    await auth.signIn();

    expect(events).toEqual(['begin', 'oauth', 'open']);
    auth.dispose();
  });

  it('stores routed callback sessions and refreshes settings profile state', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const onSessionChanged = vi.fn(async () => {});
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({
        router,
        coordinator,
        oauthClient,
        host: createAuthHost({ onSessionChanged }),
      }),
    );

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        nonce: nonceFor(oauthClient),
      }),
    );

    await vi.waitFor(() => {
      expect(coordinator.storeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        }),
      );
    });
    expect(coordinator.createSessionFromCallback).toHaveBeenCalledWith({
      path: '/auth-callback',
      query: expect.stringMatching(/^app_nonce=[0-9a-f]{32}$/),
      fragment: 'access_token=access-token&refresh_token=refresh-token',
    });
    expect(onSessionChanged).toHaveBeenCalled();

    expect(await SupabaseClient.isAuthenticated()).toBe(false);
    auth.dispose();
  });

  it('waits for the matching callback before completing sign-in', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({ router, coordinator, oauthClient }),
    );

    let completed = false;
    const completion = auth
      .signInAndWaitForSession(undefined, { timeoutMs: 1_000 })
      .then((result) => {
        completed = true;
        return result;
      });
    await vi.waitFor(() =>
      expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalled(),
    );
    expect(completed).toBe(false);

    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        nonce: nonceFor(oauthClient),
      }),
    );

    await expect(completion).resolves.toBe(true);
    expect(coordinator.storeSession).toHaveBeenCalledOnce();
    auth.dispose();
  });

  it('cancels a waiting sign-in when its window auth is disposed', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({ router, oauthClient }),
    );
    const completion = auth.signInAndWaitForSession(undefined, {
      timeoutMs: 1_000,
    });
    await vi.waitFor(() =>
      expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalled(),
    );

    auth.dispose();

    await expect(completion).resolves.toBe(false);
  });

  it('rejects a foreign callback whose nonce does not match the pending sign-in (login-CSRF)', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const oauthClient = createOAuthClient();
    const log = createLog();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({ router, coordinator, oauthClient, log }),
    );

    await auth.signIn();
    // Attacker-delivered deeplink carrying valid tokens for another account but
    // NOT the nonce this client minted in its redirect_to.
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'attacker-access',
        refreshToken: 'attacker-refresh',
        nonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
      }),
    );
    await Promise.resolve();

    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(coordinator.storeSession).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Desktop auth callback rejected: nonce mismatch (possible login-CSRF or stale callback)',
    );
    auth.dispose();
  });

  it('rejects a callback with no nonce while a sign-in is pending', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({ router, coordinator }),
    );

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    );
    await Promise.resolve();

    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(coordinator.storeSession).not.toHaveBeenCalled();
    auth.dispose();
  });

  it('ignores routed callbacks until desktop sign-in starts', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const log = createLog();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({ router, coordinator, log }),
    );

    router.routeUrl(
      'texra://texra-ai.texra/auth-callback#access_token=access-token&refresh_token=refresh-token',
    );

    await Promise.resolve();

    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(coordinator.storeSession).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      'Desktop auth callback ignored because no sign-in is in progress',
    );
    auth.dispose();
  });

  it('preserves pending sign-in across desktop auth recreation', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const stateStore = createStateStore();
    const callbackState = createDesktopAuthCallbackState(stateStore);
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({
        router,
        coordinator,
        oauthClient,
        callbackState,
      }),
    );

    await auth.signIn();
    auth.dispose();
    const persistedCallbackState = createDesktopAuthCallbackState(stateStore);
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        nonce: nonceFor(oauthClient),
      }),
    );

    const recreatedAuth = createDesktopSupabaseAuth(
      createAuthOptions({
        router,
        coordinator,
        callbackState: persistedCallbackState,
      }),
    );

    await vi.waitFor(() => {
      expect(coordinator.storeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        }),
      );
    });
    recreatedAuth.dispose();
  });

  it('expires persisted pending sign-in state across recreation', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-06T00:00:00Z'));
      const router = createDesktopProtocolCallbackRouter();
      const coordinator = createCoordinator();
      const stateStore = createStateStore();
      const oauthClient = createOAuthClient();
      const auth = createDesktopSupabaseAuth(
        createAuthOptions({
          router,
          coordinator,
          oauthClient,
          callbackState: createDesktopAuthCallbackState(stateStore),
        }),
      );

      await auth.signIn();
      auth.dispose();

      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      const expiredCallbackState = createDesktopAuthCallbackState(stateStore);
      const recreatedAuth = createDesktopSupabaseAuth(
        createAuthOptions({
          router,
          coordinator,
          callbackState: expiredCallbackState,
        }),
      );

      router.routeUrl(
        authCallbackUrl({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        }),
      );
      await Promise.resolve();

      expect(expiredCallbackState.hasPendingSignIn()).toBe(false);
      expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
      recreatedAuth.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears expired pending state when matching a nonce directly', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-06T00:00:00Z'));
      const stateStore = createStateStore();
      const callbackState = createDesktopAuthCallbackState(stateStore);

      await callbackState.beginAuthAttempt('attempt-nonce');
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);

      expect(callbackState.matchesPendingNonce('attempt-nonce')).toBe(false);
      expect(callbackState.hasPendingSignIn()).toBe(false);
      expect(
        createDesktopAuthCallbackState(stateStore).hasPendingSignIn(),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes expired-state cleanup before persisting a newer attempt', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-06T00:00:00Z'));
      const stateStore = createStateStore();
      const initialState = createDesktopAuthCallbackState(stateStore);
      await initialState.beginAuthAttempt('expired-nonce');
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);

      const cleanup = createDeferred<void>();
      const update = stateStore.update.bind(stateStore);
      vi.spyOn(stateStore, 'update').mockImplementationOnce(
        async (key, value) => {
          await cleanup.promise;
          await update(key, value);
        },
      );

      const recreatedState = createDesktopAuthCallbackState(stateStore);
      const beginNewAttempt = recreatedState.beginAuthAttempt('new-nonce');
      await vi.waitFor(() => {
        expect(stateStore.update).toHaveBeenCalledOnce();
      });

      cleanup.resolve();
      await beginNewAttempt;

      const persistedState = createDesktopAuthCallbackState(stateStore);
      expect(persistedState.matchesPendingNonce('new-nonce')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending callback state on sign-out', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const callbackState = createDesktopAuthCallbackState();
    const oauthClient = createOAuthClient();
    const log = createLog();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({
        router,
        coordinator,
        oauthClient,
        callbackState,
        log,
      }),
    );

    await auth.signIn();
    await auth.signOut();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        nonce: nonceFor(oauthClient),
      }),
    );

    await Promise.resolve();

    expect(callbackState.hasPendingSignIn()).toBe(false);
    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      'Desktop auth callback ignored because no sign-in is in progress',
    );
    auth.dispose();
  });

  it('claims only the first matching callback for an OAuth attempt', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const log = createLog();
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({ router, coordinator, oauthClient, log }),
    );

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'first',
        refreshToken: 'first',
        nonce: nonceFor(oauthClient),
      }),
    );
    router.routeUrl(
      authCallbackUrl({ accessToken: 'second', refreshToken: 'second' }),
    );

    await vi.waitFor(() => {
      expect(coordinator.createSessionFromCallback).toHaveBeenCalledTimes(1);
      expect(coordinator.storeSession).toHaveBeenCalledTimes(1);
    });
    expect(log.debug).toHaveBeenCalledWith(
      'Desktop auth callback ignored because no sign-in is in progress',
    );
    auth.dispose();
  });

  it('does not store a superseded callback or clear the newer sign-in', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const callbackState = createDesktopAuthCallbackState();
    const oauthClient = createOAuthClient();
    const callbackProcessing = createDeferred<void>();
    coordinator.createSessionFromCallback.mockImplementationOnce(async () => {
      await callbackProcessing.promise;
      return callbackSessionResult();
    });
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({
        router,
        coordinator,
        oauthClient,
        callbackState,
      }),
    );

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        nonce: nonceFor(oauthClient),
      }),
    );
    await vi.waitFor(() => {
      expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();
    });

    await auth.signIn();
    callbackProcessing.resolve();

    await new Promise((resolve) => setImmediate(resolve));
    expect(coordinator.storeSession).not.toHaveBeenCalled();
    expect(callbackState.hasPendingSignIn()).toBe(true);
    auth.dispose();
  });

  it('removes a callback session when sign-out begins during storage', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const oauthClient = createOAuthClient();
    const sessionStorage = createDeferred<void>();
    const storeSession = coordinator.storeSession.getMockImplementation();
    coordinator.storeSession.mockImplementationOnce(async (session) => {
      await sessionStorage.promise;
      await storeSession?.(session);
    });
    const onSessionChanged = vi.fn(async () => {});
    const showInfoMessage = vi.fn(async () => {});
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({
        router,
        coordinator,
        oauthClient,
        host: createAuthHost({ onSessionChanged, showInfoMessage }),
      }),
    );

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'stale-access-token',
        refreshToken: 'stale-refresh-token',
        nonce: nonceFor(oauthClient),
      }),
    );
    await vi.waitFor(() => {
      expect(coordinator.storeSession).toHaveBeenCalledOnce();
    });

    const signOut = auth.signOut();
    sessionStorage.resolve();
    await signOut;

    expect(await coordinator.loadSession()).toBeNull();
    expect(showInfoMessage).not.toHaveBeenCalledWith(
      'Signed in as user@example.com',
    );
    expect(onSessionChanged).toHaveBeenCalledOnce();
    auth.dispose();
  });

  it('removes a stored callback before starting a newer sign-in', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const callbackState = createDesktopAuthCallbackState();
    const oauthClient = createOAuthClient();
    const sessionStorage = createDeferred<void>();
    const storeSession = coordinator.storeSession.getMockImplementation();
    coordinator.storeSession.mockImplementationOnce(async (session) => {
      await sessionStorage.promise;
      await storeSession?.(session);
    });
    const onSessionChanged = vi.fn(async () => {});
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({
        router,
        coordinator,
        oauthClient,
        callbackState,
        host: createAuthHost({ onSessionChanged }),
      }),
    );

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'stale-access-token',
        refreshToken: 'stale-refresh-token',
        nonce: nonceFor(oauthClient),
      }),
    );
    await vi.waitFor(() => {
      expect(coordinator.storeSession).toHaveBeenCalledOnce();
    });

    const newerSignIn = auth.signIn();
    expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalledOnce();
    sessionStorage.resolve();
    await newerSignIn;

    expect(coordinator.clearSession).toHaveBeenCalledOnce();
    expect(await coordinator.loadSession()).toBeNull();
    expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalledTimes(2);
    expect(callbackState.hasPendingSignIn()).toBe(true);
    expect(onSessionChanged).not.toHaveBeenCalled();

    router.routeUrl(
      authCallbackUrl({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        nonce: nonceFor(oauthClient),
      }),
    );
    await vi.waitFor(() => {
      expect(coordinator.storeSession).toHaveBeenCalledTimes(2);
      expect(onSessionChanged).toHaveBeenCalledOnce();
    });

    expect(coordinator.clearSession).toHaveBeenCalledOnce();
    expect(await coordinator.loadSession()).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    auth.dispose();
  });

  it.each(['signIn', 'dispose'] as const)(
    'removes a callback session when %s invalidates it during session refresh',
    async (action) => {
      const router = createDesktopProtocolCallbackRouter();
      const coordinator = createCoordinator();
      const oauthClient = createOAuthClient();
      const sessionRefresh = createDeferred<void>();
      const onSessionChanged = vi.fn(async () => {
        await sessionRefresh.promise;
      });
      const auth = createDesktopSupabaseAuth(
        createAuthOptions({
          router,
          coordinator,
          oauthClient,
          host: createAuthHost({ onSessionChanged }),
        }),
      );

      await auth.signIn();
      router.routeUrl(
        authCallbackUrl({
          accessToken: 'stale-access-token',
          refreshToken: 'stale-refresh-token',
          nonce: nonceFor(oauthClient),
        }),
      );
      await vi.waitFor(() => {
        expect(onSessionChanged).toHaveBeenCalledOnce();
      });

      const newerSignIn = action === 'signIn' ? auth.signIn() : undefined;
      if (action === 'dispose') auth.dispose();
      sessionRefresh.resolve();
      await newerSignIn;
      await vi.waitFor(() => {
        expect(coordinator.clearSession).toHaveBeenCalledOnce();
      });

      expect(await coordinator.loadSession()).toBeNull();
      if (action === 'signIn') {
        expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalledTimes(2);
        auth.dispose();
      }
    },
  );

  it.each(['signOut', 'dispose'] as const)(
    'does not store a claimed callback after %s',
    async (action) => {
      const router = createDesktopProtocolCallbackRouter();
      const coordinator = createCoordinator();
      const oauthClient = createOAuthClient();
      const callbackProcessing = createDeferred<void>();
      coordinator.createSessionFromCallback.mockImplementationOnce(async () => {
        await callbackProcessing.promise;
        return callbackSessionResult();
      });
      const auth = createDesktopSupabaseAuth(
        createAuthOptions({ router, coordinator, oauthClient }),
      );

      await auth.signIn();
      router.routeUrl(
        authCallbackUrl({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          nonce: nonceFor(oauthClient),
        }),
      );
      await vi.waitFor(() => {
        expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();
      });

      if (action === 'signOut') await auth.signOut();
      else auth.dispose();
      callbackProcessing.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      expect(coordinator.storeSession).not.toHaveBeenCalled();
      if (action === 'signOut') auth.dispose();
    },
  );

  it('keeps a newer attempt valid beyond a superseded waiter timeout', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({ router, coordinator, oauthClient }),
    );

    const first = auth.signInAndWaitForSession(undefined, { timeoutMs: 10 });
    await vi.waitFor(() => {
      expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalledOnce();
    });
    const second = auth.signInAndWaitForSession(undefined, {
      timeoutMs: 1_000,
    });
    await expect(first).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    router.routeUrl(
      authCallbackUrl({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        nonce: nonceFor(oauthClient),
      }),
    );

    await expect(second).resolves.toBe(true);
    expect(coordinator.storeSession).toHaveBeenCalledOnce();
    auth.dispose();
  });

  it('surfaces rejected routed callback processing failures', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    coordinator.createSessionFromCallback.mockRejectedValueOnce(
      new Error('network down'),
    );
    const showErrorMessage = vi.fn(async () => {});
    const log = createLog();
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({
        router,
        coordinator,
        oauthClient,
        host: createAuthHost({ showErrorMessage }),
        log,
      }),
    );

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        nonce: nonceFor(oauthClient),
      }),
    );

    await vi.waitFor(() => {
      expect(showErrorMessage).toHaveBeenCalledWith(
        'Sign-in failed: network down',
      );
    });
    expect(log.error).toHaveBeenCalledWith(
      'Desktop auth callback failed: network down',
    );
    expect(coordinator.storeSession).not.toHaveBeenCalled();
    auth.dispose();
  });

  it('clears included-access caches on sign-out', async () => {
    const coordinator = createCoordinator();
    const clearAllCaches = vi.fn();
    setServerSideKeyService({ clearAllCaches } as never);
    const auth = createDesktopSupabaseAuth(createAuthOptions({ coordinator }));

    await auth.signOut();

    expect(coordinator.clearSession).toHaveBeenCalled();
    expect(clearAllCaches).toHaveBeenCalledOnce();
    expect(
      agentRegistry.invalidateRemoteAgentsAfterSignOut,
    ).toHaveBeenCalledOnce();
    auth.dispose();
  });

  it('still publishes sign-out when the local catalog rebuild fails', async () => {
    vi.mocked(
      agentRegistry.invalidateRemoteAgentsAfterSignOut,
    ).mockRejectedValueOnce(new Error('local rebuild failed'));
    const coordinator = createCoordinator();
    const onSessionChanged = vi.fn(async () => {});
    const log = createLog();
    const auth = createDesktopSupabaseAuth(
      createAuthOptions({
        coordinator,
        host: createAuthHost({ onSessionChanged }),
        log,
      }),
    );

    await expect(auth.signOut()).resolves.toBeUndefined();

    expect(coordinator.clearSession).toHaveBeenCalledOnce();
    expect(onSessionChanged).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      'Local agent catalog refresh failed after sign-out: local rebuild failed',
    );
    auth.dispose();
  });

  it('refreshes desktop session state and exposes remote agents in profile data', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const { ensureFreshToken } = installAuthenticatedSupabaseProvider();
    const loadAgents = vi
      .spyOn(agentRegistry, 'loadAgents')
      .mockResolvedValue(undefined);
    vi.spyOn(agentRegistry, 'getAgentsBySource').mockReturnValue([
      {
        name: 'remoteWriter',
        source: 'remote',
        path: '',
        defaultOutputFiles: ['main.tex'],
        category: AgentCategory.Workflow,
        description: 'Remote writer',
        visibility: ['public', 'researcher'],
      },
    ]);
    const auth = createDesktopSupabaseAuth(createAuthOptions({ router }));

    const message = await buildProfileMessage({
      getProviderKeyStatuses: async () => [],
    });

    expect(ensureFreshToken).toHaveBeenCalled();
    expect(loadAgents).toHaveBeenCalled();
    expect(message).toMatchObject({
      authenticated: true,
      user: { email: 'user@example.com', id: 'user-1' },
      tier: 'free',
      permissions: ['public'],
      remoteAgents: [
        {
          name: 'remoteWriter',
          description: 'Remote writer',
          visibility: ['public', 'researcher'],
          category: 'workflow',
          supportsMultipleOutput: true,
        },
      ],
    });
    auth.dispose();
  });

  it('keeps authenticated profile data when remote agent refresh fails', async () => {
    const router = createDesktopProtocolCallbackRouter();
    installAuthenticatedSupabaseProvider();
    vi.spyOn(agentRegistry, 'loadAgents').mockRejectedValue(
      new Error('agent directory unavailable'),
    );
    const getAgentsBySource = vi
      .spyOn(agentRegistry, 'getAgentsBySource')
      .mockReturnValue([]);
    const auth = createDesktopSupabaseAuth(createAuthOptions({ router }));

    const message = await buildProfileMessage({
      getProviderKeyStatuses: async () => [],
    });

    expect(message).toMatchObject({
      authenticated: true,
      user: { email: 'user@example.com', id: 'user-1' },
      remoteAgents: [],
    });
    expect(getAgentsBySource).not.toHaveBeenCalled();
    auth.dispose();
  });
});
