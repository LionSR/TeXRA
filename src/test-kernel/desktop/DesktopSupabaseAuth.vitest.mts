import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/AgentDataclass';
import * as agentRegistry from '@agent/index/agentRegistry';
import { SupabaseClient } from '@auth/SupabaseClient';
import type { SupabaseSession } from '@auth/SupabaseSession';
import { setServerSideKeyService } from '@auth/serverKeys';
import { createDesktopProtocolCallbackRouter } from '@desktop/main/desktopProtocolCallbacks';
import {
  createDesktopAuthCallbackState,
  createDesktopSupabaseAuth,
  type DesktopOAuthClient,
  type DesktopAuthProfileData,
} from '@desktop/main/desktopSupabaseAuth';
import type { StateStore } from '@platform/interfaces/state';

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

function authCallbackUrl(input: {
  accessToken: string;
  refreshToken: string;
}): string {
  const fragment = new URLSearchParams({
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
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
  afterEach(() => {
    vi.restoreAllMocks();
    SupabaseClient.resetForTests();
  });

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
    });

    await auth.signIn();

    expect(oauthClient.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'github',
      options: {
        redirectTo: 'texra://texra-ai.texra/auth-callback',
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
    });

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
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
      fragment: 'access_token=access-token&refresh_token=refresh-token',
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
    const stateStore = createStateStore();
    const callbackState = createDesktopAuthCallbackState(stateStore);
    const oauthClient = createOAuthClient();
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient,
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      callbackState,
    });

    await auth.signIn();
    auth.dispose();
    const persistedCallbackState = createDesktopAuthCallbackState(stateStore);
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    );

    const recreatedAuth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient: createOAuthClient(),
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
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
      const auth = createDesktopSupabaseAuth({
        router,
        coordinator,
        oauthClient,
        secrets: createSecrets(),
        openExternalUrl: vi.fn(async () => {}),
        callbackState: createDesktopAuthCallbackState(stateStore),
      });

      await auth.signIn();
      auth.dispose();

      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      const expiredCallbackState = createDesktopAuthCallbackState(stateStore);
      const recreatedAuth = createDesktopSupabaseAuth({
        router,
        coordinator,
        oauthClient: createOAuthClient(),
        secrets: createSecrets(),
        openExternalUrl: vi.fn(async () => {}),
        callbackState: expiredCallbackState,
      });

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

  it('cancels pending callback state on sign-out', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const callbackState = createDesktopAuthCallbackState();
    const oauthClient = createOAuthClient();
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient,
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
      callbackState,
      log,
    });

    await auth.signIn();
    await auth.signOut();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
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
    });

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({ accessToken: 'first', refreshToken: 'first' }),
    );
    router.routeUrl(
      authCallbackUrl({ accessToken: 'second', refreshToken: 'second' }),
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
    });

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    );
    await vi.waitFor(() => {
      expect(coordinator.createSessionFromCallback).toHaveBeenCalledOnce();
    });

    await auth.signIn();
    callbackProcessing.resolve();

    await vi.waitFor(() => {
      expect(coordinator.storeSession).toHaveBeenCalledOnce();
    });
    expect(callbackState.hasPendingSignIn()).toBe(true);
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
    });

    await auth.signIn();
    router.routeUrl(
      authCallbackUrl({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
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
    });

    await auth.signOut();

    expect(coordinator.clearSession).toHaveBeenCalled();
    expect(clearAllCaches).toHaveBeenCalledOnce();
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
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator: createCoordinator(),
      oauthClient: createOAuthClient(),
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
    });

    const profile = await auth.getProfileData();

    expect(ensureFreshToken).toHaveBeenCalled();
    expect(loadAgents).toHaveBeenCalled();
    expect(profile).toMatchObject({
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
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator: createCoordinator(),
      oauthClient: createOAuthClient(),
      secrets: createSecrets(),
      openExternalUrl: vi.fn(async () => {}),
    });

    const profile = await auth.getProfileData();

    expect(profile).toMatchObject({
      authenticated: true,
      user: { email: 'user@example.com', id: 'user-1' },
      remoteAgents: [],
    });
    expect(getAgentsBySource).not.toHaveBeenCalled();
    auth.dispose();
  });
});
