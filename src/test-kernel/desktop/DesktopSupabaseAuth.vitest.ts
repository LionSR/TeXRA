import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as agentRegistry from '@agent/index/agentRegistry';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { SupabaseSession } from '@auth/SupabaseSession';
import { SettingsProfileController } from '@controllers/settingsView/SettingsProfileController';
import {
  createDesktopProtocolCallbackRouter,
  parseDesktopProtocolCallback,
  type DesktopProtocolCallbackRouter,
} from '@desktop/main/desktopProtocolCallbacks';
import {
  createDesktopAuthCallbackState,
  createDesktopSupabaseAuth,
  type DesktopAuthCallbackState,
  type DesktopAuthCoordinator,
  type DesktopOAuthClient,
  type DesktopSupabaseAuthHost,
} from '@desktop/main/desktopSupabaseAuth';
import { createDeferred } from '@test/support/asyncTestUtils';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';

function createCoordinator() {
  const storedSession: { current: SupabaseSession | null } = { current: null };
  const createSessionFromCallback = vi.fn<
    DesktopAuthCoordinator['createSessionFromCallback']
  >(async () => callbackSessionResult());
  return {
    loadSession: vi.fn(async () => storedSession.current),
    storeSession: vi.fn(async (session: SupabaseSession) => {
      storedSession.current = session;
    }),
    clearSession: vi.fn(async () => {
      storedSession.current = null;
    }),
    createSessionFromCallback,
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

interface DesktopAuthTestOptions extends Partial<DesktopSupabaseAuthHost> {
  router: DesktopProtocolCallbackRouter;
  coordinator: DesktopAuthCoordinator;
  oauthClient: DesktopOAuthClient;
  callbackState?: DesktopAuthCallbackState;
  log?: ReturnType<typeof createLog>;
}

/** Auths created by `createTestAuth`, disposed after each test. */
const testAuths: Array<{ dispose(): void }> = [];

function createTestAuth(options: DesktopAuthTestOptions) {
  const {
    router,
    coordinator,
    oauthClient,
    callbackState = createDesktopAuthCallbackState(createLog()),
    log = createLog(),
    openExternalUrl = vi.fn(async () => {}),
    showInfoMessage = vi.fn(),
    showErrorMessage = vi.fn(),
    onSessionChanged = vi.fn(),
  } = options;
  const auth = createDesktopSupabaseAuth({
    router,
    coordinator,
    oauthClient,
    callbackState,
    host: {
      openExternalUrl,
      showInfoMessage,
      showErrorMessage,
      onSessionChanged,
    },
    log,
  });
  testAuths.push(auth);
  return auth;
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

function createOAuthClient() {
  type SignInWithOAuth = DesktopOAuthClient['auth']['signInWithOAuth'];
  type SignInInput = Parameters<SignInWithOAuth>[0];
  type SignInResult = Awaited<ReturnType<SignInWithOAuth>>;
  return {
    auth: {
      signInWithOAuth: vi.fn(
        async (_input: SignInInput): Promise<SignInResult> => ({
          data: { url: 'https://auth.example.test/start' },
          error: null,
        }),
      ),
    },
  };
}

/**
 * Builds the router/coordinator/oauthClient/auth set most tests need; tests
 * pass only the pieces they observe or customize.
 */
function createAuthSetup(options: Partial<DesktopAuthTestOptions> = {}) {
  const router = options.router ?? createDesktopProtocolCallbackRouter();
  const coordinator =
    (options.coordinator as ReturnType<typeof createCoordinator> | undefined) ??
    createCoordinator();
  const oauthClient =
    (options.oauthClient as ReturnType<typeof createOAuthClient> | undefined) ??
    createOAuthClient();
  const auth = createTestAuth({ ...options, router, coordinator, oauthClient });
  return { router, coordinator, oauthClient, auth };
}

/** Holds the next storeSession call until the returned gate resolves. */
function gateNextStoreSession(
  coordinator: ReturnType<typeof createCoordinator>,
) {
  const gate = createDeferred<void>();
  const storeSession = coordinator.storeSession.getMockImplementation();
  coordinator.storeSession.mockImplementationOnce(async (session) => {
    await gate.promise;
    await storeSession?.(session);
  });
  return gate;
}

/** Holds the next createSessionFromCallback call until the gate resolves. */
function gateNextCallbackProcessing(
  coordinator: ReturnType<typeof createCoordinator>,
) {
  const gate = createDeferred<void>();
  coordinator.createSessionFromCallback.mockImplementationOnce(async () => {
    await gate.promise;
    return callbackSessionResult();
  });
  return gate;
}

function authCallbackUrl(input: { code: string; nonce?: string }): string {
  const query = new URLSearchParams({
    code: input.code,
  });
  if (input.nonce) query.set('app_nonce', input.nonce);
  return `texra://texra-ai.texra/auth-callback?${query}`;
}

/** Extract the app_nonce that signIn placed on its OAuth redirect_to. */
function nonceFor(oauthClient: ReturnType<typeof createOAuthClient>): string {
  const call = oauthClient.auth.signInWithOAuth.mock.calls.at(-1)?.[0];
  const redirectTo = call?.options?.redirectTo ?? '';
  const callback = parseDesktopProtocolCallback(redirectTo);
  return new URLSearchParams(callback?.query).get('app_nonce') ?? '';
}

/** Routes the callback carrying the nonce the latest sign-in attempt minted. */
function routeMatchingCallback(
  router: DesktopProtocolCallbackRouter,
  oauthClient: ReturnType<typeof createOAuthClient>,
  code = 'authorization-code',
): void {
  router.routeUrl(authCallbackUrl({ code, nonce: nonceFor(oauthClient) }));
}

function installAuthenticatedSupabaseProvider() {
  const ensureFreshToken = vi.fn(async () => 'fresh-access-token');
  const getSessionTokens = vi.fn(async () => ({
    accessToken: 'fresh-access-token',
    refreshToken: 'refresh-token',
  }));
  const getStoredSessionState = vi.fn(async () => 'authenticated' as const);
  SupabaseClient.initialize(
    'https://example.supabase.co',
    'public-key',
    new FakeSecrets(),
  );
  SupabaseClient.setAuthProvider({
    whenReady: vi.fn(async () => {}),
    ensureFreshToken,
    getSessionTokens,
    getStoredSessionState,
    getStoredAccountLabel: vi.fn(async () => null),
    isTokenExpiringSoon: vi.fn(() => false),
    getLastRefreshFailure: vi.fn(() => null),
  });
  vi.spyOn(SupabaseClient, 'getUser').mockResolvedValue({
    id: 'user-1',
    email: 'user@example.com',
  } as never);
  return { ensureFreshToken, getSessionTokens, getStoredSessionState };
}

describe('desktop Supabase auth', () => {
  beforeEach(() => {
    vi.spyOn(
      agentRegistry,
      'invalidateRemoteAgentsAfterSignOut',
    ).mockResolvedValue(undefined);
  });
  afterEach(() => {
    for (const auth of testAuths.splice(0)) auth.dispose();
    vi.restoreAllMocks();
    SupabaseClient.resetForTests();
  });

  it('opens Supabase OAuth with the desktop texra callback URI', async () => {
    const openExternalUrl = vi.fn(async () => {});
    const { oauthClient, auth } = createAuthSetup({ openExternalUrl });

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
  });

  it('persists the nonce before sending it to Supabase', async () => {
    const events: string[] = [];
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
    const { auth } = createAuthSetup({
      oauthClient,
      callbackState,
      openExternalUrl,
    });

    await auth.signIn();

    expect(events).toEqual(['begin', 'oauth', 'open']);
  });

  it('stores routed callback sessions and refreshes settings profile state', async () => {
    const onSessionChanged = vi.fn(async () => {});
    const { router, coordinator, oauthClient, auth } = createAuthSetup({
      onSessionChanged,
    });

    await auth.signIn();
    routeMatchingCallback(router, oauthClient);

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
      query: expect.stringMatching(
        /^code=authorization-code&app_nonce=[0-9a-f]{32}$/,
      ),
    });
    expect(onSessionChanged).toHaveBeenCalled();

    expect(await SupabaseClient.isAuthenticated()).toBe(false);
  });

  it('waits for the matching callback before completing sign-in', async () => {
    const { router, coordinator, oauthClient, auth } = createAuthSetup();

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

    routeMatchingCallback(router, oauthClient);

    await expect(completion).resolves.toBe(true);
    expect(coordinator.storeSession).toHaveBeenCalledOnce();
  });

  it('cancels a waiting system-browser sign-in without throwing', async () => {
    const { oauthClient, auth } = createAuthSetup();
    const completion = auth.signInAndWaitForSession(undefined, {
      timeoutMs: 1_000,
    });
    await vi.waitFor(() =>
      expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalled(),
    );

    auth.dispose();

    await expect(completion).resolves.toBe(false);
  });

  it('treats a denied system-browser callback as cancellation', async () => {
    const showErrorMessage = vi.fn(async () => {});
    const log = createLog();
    const { router, coordinator, oauthClient, auth } = createAuthSetup({
      showErrorMessage,
      log,
    });
    coordinator.createSessionFromCallback.mockResolvedValueOnce({
      success: false,
      error: 'The user closed the authorization page',
      isAuthError: true,
    });
    const completion = auth.signInAndWaitForSession(undefined, {
      timeoutMs: 1_000,
    });
    await vi.waitFor(() =>
      expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalled(),
    );

    const nonce = nonceFor(oauthClient);
    router.routeUrl(
      `texra://texra-ai.texra/auth-callback?app_nonce=${nonce}&error=access_denied`,
    );

    await expect(completion).resolves.toBe(false);
    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'Desktop sign-in was cancelled in the system browser',
    );
    expect(coordinator.storeSession).not.toHaveBeenCalled();
  });

  it('contains a failed cancellation notification without rejecting', async () => {
    const log = createLog();
    const { router, coordinator, oauthClient, auth } = createAuthSetup({
      showErrorMessage: vi.fn(async () => {
        throw new Error('notification failure');
      }),
      log,
    });
    coordinator.createSessionFromCallback.mockRejectedValueOnce(
      new Error('callback failure'),
    );
    const completion = auth.signInAndWaitForSession(undefined, {
      timeoutMs: 1_000,
    });
    await vi.waitFor(() =>
      expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalled(),
    );

    routeMatchingCallback(router, oauthClient);

    await expect(completion).resolves.toBe(false);
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        'Desktop sign-in error notification failed: notification failure',
      ),
    );
  });

  it('rejects a foreign callback whose nonce does not match the pending sign-in (login-CSRF)', async () => {
    const log = createLog();
    const { router, coordinator, oauthClient, auth } = createAuthSetup({ log });

    await auth.signIn();
    // Attacker-delivered deeplink carrying a valid code for another account but
    // NOT the nonce this client minted in its redirect_to.
    router.routeUrl(
      authCallbackUrl({
        code: 'attacker-code',
        nonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
      }),
    );
    await Promise.resolve();

    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(coordinator.storeSession).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Desktop auth callback rejected: nonce mismatch (possible login-CSRF or stale callback)',
    );
  });

  it('rejects a callback with no nonce while a sign-in is pending', async () => {
    const { router, coordinator, auth } = createAuthSetup();

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        code: 'authorization-code',
      }),
    );
    await Promise.resolve();

    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(coordinator.storeSession).not.toHaveBeenCalled();
  });

  it('ignores routed callbacks until desktop sign-in starts', async () => {
    const log = createLog();
    const { router, coordinator } = createAuthSetup({ log });

    router.routeUrl(
      'texra://texra-ai.texra/auth-callback?code=authorization-code',
    );

    await Promise.resolve();

    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(coordinator.storeSession).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      'Desktop auth callback ignored because no sign-in is in progress',
    );
  });

  it('preserves pending sign-in across desktop auth recreation', async () => {
    const stateStore = new FakeStateStore();
    const callbackState = createDesktopAuthCallbackState(
      createLog(),
      stateStore,
    );
    const { router, coordinator, oauthClient, auth } = createAuthSetup({
      callbackState,
    });

    await auth.signIn();
    auth.dispose();
    const persistedCallbackState = createDesktopAuthCallbackState(
      createLog(),
      stateStore,
    );
    routeMatchingCallback(router, oauthClient);

    createTestAuth({
      router,
      coordinator,
      oauthClient: createOAuthClient(),
      callbackState: persistedCallbackState,
    });

    await vi.waitFor(() => {
      expect(coordinator.storeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        }),
      );
    });
  });

  it('expires persisted pending sign-in state across recreation', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-06T00:00:00Z'));
      const stateStore = new FakeStateStore();
      const { router, coordinator, auth } = createAuthSetup({
        callbackState: createDesktopAuthCallbackState(createLog(), stateStore),
      });

      await auth.signIn();
      auth.dispose();

      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      const expiredCallbackState = createDesktopAuthCallbackState(
        createLog(),
        stateStore,
      );
      createTestAuth({
        router,
        coordinator,
        oauthClient: createOAuthClient(),
        callbackState: expiredCallbackState,
      });

      router.routeUrl(
        authCallbackUrl({
          code: 'authorization-code',
        }),
      );
      await Promise.resolve();

      expect(expiredCallbackState.hasPendingSignIn()).toBe(false);
      expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears expired pending state when matching a nonce directly', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-06T00:00:00Z'));
      const stateStore = new FakeStateStore();
      const callbackState = createDesktopAuthCallbackState(
        createLog(),
        stateStore,
      );

      await callbackState.beginAuthAttempt('attempt-nonce');
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);

      expect(callbackState.matchesPendingNonce('attempt-nonce')).toBe(false);
      expect(callbackState.hasPendingSignIn()).toBe(false);
      expect(
        createDesktopAuthCallbackState(
          createLog(),
          stateStore,
        ).hasPendingSignIn(),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes expired-state cleanup before persisting a newer attempt', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-06T00:00:00Z'));
      const stateStore = new FakeStateStore();
      const initialState = createDesktopAuthCallbackState(
        createLog(),
        stateStore,
      );
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

      const recreatedState = createDesktopAuthCallbackState(
        createLog(),
        stateStore,
      );
      const beginNewAttempt = recreatedState.beginAuthAttempt('new-nonce');
      await vi.waitFor(() => {
        expect(stateStore.update).toHaveBeenCalledOnce();
      });

      cleanup.resolve();
      await beginNewAttempt;

      const persistedState = createDesktopAuthCallbackState(
        createLog(),
        stateStore,
      );
      expect(persistedState.matchesPendingNonce('new-nonce')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending callback state on sign-out', async () => {
    const callbackState = createDesktopAuthCallbackState(createLog());
    const log = createLog();
    const { router, coordinator, oauthClient, auth } = createAuthSetup({
      callbackState,
      log,
    });

    await auth.signIn();
    await auth.signOut();
    routeMatchingCallback(router, oauthClient);

    await Promise.resolve();

    expect(callbackState.hasPendingSignIn()).toBe(false);
    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      'Desktop auth callback ignored because no sign-in is in progress',
    );
  });

  it('claims only the first matching callback for an OAuth attempt', async () => {
    const log = createLog();
    const { router, coordinator, oauthClient, auth } = createAuthSetup({ log });

    await auth.signIn();
    routeMatchingCallback(router, oauthClient, 'first');
    router.routeUrl(authCallbackUrl({ code: 'second' }));

    await vi.waitFor(() => {
      expect(coordinator.createSessionFromCallback).toHaveBeenCalledTimes(1);
      expect(coordinator.storeSession).toHaveBeenCalledTimes(1);
    });
    expect(log.debug).toHaveBeenCalledWith(
      'Desktop auth callback ignored because no sign-in is in progress',
    );
  });

  it('does not store a superseded callback or clear the newer sign-in', async () => {
    const callbackState = createDesktopAuthCallbackState(createLog());
    const { router, coordinator, oauthClient, auth } = createAuthSetup({
      callbackState,
    });
    const callbackProcessing = gateNextCallbackProcessing(coordinator);

    await auth.signIn();
    routeMatchingCallback(router, oauthClient);
    await vi.waitFor(() => {
      expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();
    });

    await auth.signIn();
    callbackProcessing.resolve();

    await new Promise((resolve) => setImmediate(resolve));
    expect(coordinator.storeSession).not.toHaveBeenCalled();
    expect(callbackState.hasPendingSignIn()).toBe(true);
  });

  it('removes a callback session when sign-out begins during storage', async () => {
    const onSessionChanged = vi.fn(async () => {});
    const showInfoMessage = vi.fn(async () => {});
    const { router, coordinator, oauthClient, auth } = createAuthSetup({
      onSessionChanged,
      showInfoMessage,
    });
    const sessionStorage = gateNextStoreSession(coordinator);

    await auth.signIn();
    routeMatchingCallback(router, oauthClient, 'stale-code');
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
  });

  it('removes a stored callback before starting a newer sign-in', async () => {
    const callbackState = createDesktopAuthCallbackState(createLog());
    const onSessionChanged = vi.fn(async () => {});
    const { router, coordinator, oauthClient, auth } = createAuthSetup({
      callbackState,
      onSessionChanged,
    });
    const sessionStorage = gateNextStoreSession(coordinator);

    await auth.signIn();
    routeMatchingCallback(router, oauthClient, 'stale-code');
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

    routeMatchingCallback(router, oauthClient, 'new-code');
    await vi.waitFor(() => {
      expect(coordinator.storeSession).toHaveBeenCalledTimes(2);
      expect(onSessionChanged).toHaveBeenCalledOnce();
    });

    expect(coordinator.clearSession).toHaveBeenCalledOnce();
    expect(await coordinator.loadSession()).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });

  it.each(['signIn', 'dispose'] as const)(
    'removes a callback session when %s invalidates it during session refresh',
    async (action) => {
      const sessionRefresh = createDeferred<void>();
      const onSessionChanged = vi.fn(async () => {
        await sessionRefresh.promise;
      });
      const { router, coordinator, oauthClient, auth } = createAuthSetup({
        onSessionChanged,
      });

      await auth.signIn();
      routeMatchingCallback(router, oauthClient, 'stale-code');
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
      }
    },
  );

  it.each(['signOut', 'dispose'] as const)(
    'does not store a claimed callback after %s',
    async (action) => {
      const { router, coordinator, oauthClient, auth } = createAuthSetup();
      const callbackProcessing = gateNextCallbackProcessing(coordinator);

      await auth.signIn();
      routeMatchingCallback(router, oauthClient);
      await vi.waitFor(() => {
        expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();
      });

      if (action === 'signOut') await auth.signOut();
      else auth.dispose();
      callbackProcessing.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      expect(coordinator.storeSession).not.toHaveBeenCalled();
    },
  );

  it('keeps a newer attempt valid beyond a superseded waiter timeout', async () => {
    const { router, coordinator, oauthClient, auth } = createAuthSetup();

    const first = auth.signInAndWaitForSession(undefined, { timeoutMs: 10 });
    await vi.waitFor(() => {
      expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalledOnce();
    });
    const second = auth.signInAndWaitForSession(undefined, {
      timeoutMs: 1_000,
    });
    await expect(first).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    routeMatchingCallback(router, oauthClient, 'new-code');

    await expect(second).resolves.toBe(true);
    expect(coordinator.storeSession).toHaveBeenCalledOnce();
  });

  it('settles the waiter when starting the sign-in fails', async () => {
    const { oauthClient, auth } = createAuthSetup();
    oauthClient.auth.signInWithOAuth.mockResolvedValueOnce({
      data: { url: null },
      error: { message: 'provider unavailable' },
    });

    vi.useFakeTimers();
    try {
      await expect(
        auth.signInAndWaitForSession(undefined, { timeoutMs: 60_000 }),
      ).rejects.toThrow();
      // The waiter and its timeout go with the failed attempt, so nothing is
      // left to clear a later attempt's pending callback state.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces rejected routed callback processing failures', async () => {
    const showErrorMessage = vi.fn(async () => {});
    const log = createLog();
    const { router, coordinator, oauthClient, auth } = createAuthSetup({
      showErrorMessage,
      log,
    });
    coordinator.createSessionFromCallback.mockRejectedValueOnce(
      new Error('network down'),
    );

    await auth.signIn();
    routeMatchingCallback(router, oauthClient);

    await vi.waitFor(() => {
      expect(showErrorMessage).toHaveBeenCalledWith(
        'Sign-in failed: network down',
      );
    });
    expect(log.error).toHaveBeenCalledWith(
      'Desktop auth callback failed: network down',
    );
    expect(coordinator.storeSession).not.toHaveBeenCalled();
  });

  it('still publishes sign-out when the local catalog rebuild fails', async () => {
    vi.mocked(
      agentRegistry.invalidateRemoteAgentsAfterSignOut,
    ).mockRejectedValueOnce(new Error('local rebuild failed'));
    const onSessionChanged = vi.fn(async () => {});
    const log = createLog();
    const { coordinator, auth } = createAuthSetup({ onSessionChanged, log });

    await expect(auth.signOut()).resolves.toBeUndefined();

    expect(coordinator.clearSession).toHaveBeenCalledOnce();
    expect(onSessionChanged).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      'Local agent catalog refresh failed after sign-out: local rebuild failed',
    );
  });

  it('refreshes desktop session state for profile data without a token fetch', async () => {
    const { ensureFreshToken, getSessionTokens, getStoredSessionState } =
      installAuthenticatedSupabaseProvider();

    const controller = new SettingsProfileController({
      host: 'desktop',
      globalState: new FakeStateStore(),
      loadProviderKeyStatuses: async () => ({}),
      getConfig: (_key, defaultValue) => defaultValue,
    });
    const message = await controller.buildProfileMessage();

    expect(getStoredSessionState).toHaveBeenCalledOnce();
    expect(getSessionTokens).not.toHaveBeenCalled();
    expect(ensureFreshToken).not.toHaveBeenCalled();
    expect(message).toMatchObject({
      authenticated: true,
      user: { email: 'user@example.com' },
    });
  });
});
