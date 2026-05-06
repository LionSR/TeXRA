import { describe, expect, it, vi } from 'vitest';

import type { SupabaseSession } from '@auth/SupabaseSession';
import { setServerSideKeyService } from '@auth/serverKeys';
import { createDesktopProtocolCallbackRouter } from '../../../packages/desktop/src/main/desktopProtocolCallbacks';
import {
  createDesktopAuthCallbackState,
  createDesktopSupabaseAuth,
  type DesktopOAuthClient,
  type DesktopAuthProfileData,
} from '../../../packages/desktop/src/main/desktopSupabaseAuth';

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
    createSessionFromCallback: vi.fn(async () => ({
      success: true as const,
      session: {
        id: 'user-1',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        account: { id: 'user-1', label: 'user@example.com' },
        expiresAt: Date.now() + 60_000,
      },
    })),
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

function createSecrets() {
  return {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
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

function getOAuthState(oauthClient: ReturnType<typeof createOAuthClient>) {
  const state =
    oauthClient.auth.signInWithOAuth.mock.calls.at(-1)?.[0].options.queryParams
      ?.state;
  expect(state).toEqual(expect.any(String));
  return state!;
}

function authCallbackUrl(input: {
  accessToken: string;
  refreshToken: string;
  state: string;
}): string {
  const fragment = new URLSearchParams({
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    state: input.state,
  });
  return `texra://texra-ai.texra/auth-callback#${fragment}`;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('desktop Supabase auth', () => {
  it('opens Supabase OAuth with the desktop texra callback URI', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const oauthClient = createOAuthClient();
    const openExternalUrl = vi.fn(async () => {});
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient,
      secrets: createSecrets(),
      openExternalUrl,
      initializeServerSideAccess: false,
    });

    await auth.signIn();

    expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'github',
      options: {
        redirectTo: 'texra://texra-ai.texra/auth-callback',
        queryParams: { state: expect.any(String) },
      },
    });
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://auth.example.test/start',
    );
    auth.dispose();
  });

  it('stores routed callback sessions and refreshes settings profile state', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const onSessionChanged = vi.fn(async () => {});
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient,
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      onSessionChanged,
      initializeServerSideAccess: false,
    });

    await auth.signIn();
    const state = getOAuthState(oauthClient);
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        state,
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
      query: '',
      fragment: `access_token=access-token&refresh_token=refresh-token&state=${state}`,
    });
    expect(onSessionChanged).toHaveBeenCalled();

    const profile = (await auth.getProfileData()) as DesktopAuthProfileData;
    expect(profile.authenticated).toBe(false);
    auth.dispose();
  });

  it('ignores routed callbacks until desktop sign-in starts', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient: createOAuthClient(),
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      log,
      initializeServerSideAccess: false,
    });

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
    const callbackState = createDesktopAuthCallbackState();
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient,
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      callbackState,
      initializeServerSideAccess: false,
    });

    await auth.signIn();
    const state = getOAuthState(oauthClient);
    auth.dispose();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        state,
      }),
    );

    const recreatedAuth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient: createOAuthClient(),
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      callbackState,
      initializeServerSideAccess: false,
    });

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

  it('claims only the first matching callback for an OAuth attempt', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient,
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      log,
      initializeServerSideAccess: false,
    });

    await auth.signIn();
    const state = getOAuthState(oauthClient);
    router.routeUrl(
      authCallbackUrl({ accessToken: 'first', refreshToken: 'first', state }),
    );
    router.routeUrl(
      authCallbackUrl({ accessToken: 'second', refreshToken: 'second', state }),
    );

    await vi.waitFor(() => {
      expect(coordinator.createSessionFromCallback).toHaveBeenCalledTimes(1);
    });
    expect(coordinator.storeSession).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      'Desktop auth callback ignored because no sign-in is in progress',
    );
    auth.dispose();
  });

  it('ignores callbacks that do not match the active OAuth state', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient: createOAuthClient(),
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      log,
      initializeServerSideAccess: false,
    });

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        state: 'wrong-state',
      }),
    );

    await Promise.resolve();

    expect(coordinator.createSessionFromCallback).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      'Desktop auth callback ignored because it does not match the active sign-in attempt',
    );
    auth.dispose();
  });

  it('does not clear a newer sign-in while a claimed callback finishes', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const callbackState = createDesktopAuthCallbackState();
    const oauthClient = createOAuthClient();
    const callbackProcessing = createDeferred<void>();
    coordinator.createSessionFromCallback.mockImplementationOnce(async () => {
      await callbackProcessing.promise;
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
    });
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient,
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      callbackState,
      initializeServerSideAccess: false,
    });

    await auth.signIn();
    const firstState = getOAuthState(oauthClient);
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        state: firstState,
      }),
    );
    await vi.waitFor(() => {
      expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();
    });

    await auth.signIn();
    const secondState = getOAuthState(oauthClient);
    callbackProcessing.resolve();

    await vi.waitFor(() => {
      expect(coordinator.storeSession).toHaveBeenCalledOnce();
    });
    expect(callbackState.getExpectedState()).toBe(secondState);
    auth.dispose();
  });

  it('surfaces rejected routed callback processing failures', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    coordinator.createSessionFromCallback.mockRejectedValueOnce(
      new Error('network down'),
    );
    const showErrorMessage = vi.fn(async () => {});
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient,
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      showErrorMessage,
      log,
      initializeServerSideAccess: false,
    });

    await auth.signIn();
    const state = getOAuthState(oauthClient);
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        state,
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
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const clearAllCaches = vi.fn();
    setServerSideKeyService({ clearAllCaches } as never);
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient: createOAuthClient(),
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      initializeServerSideAccess: false,
    });

    await auth.signOut();

    expect(coordinator.clearSession).toHaveBeenCalled();
    expect(clearAllCaches).toHaveBeenCalledOnce();
    auth.dispose();
  });
});
