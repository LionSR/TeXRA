import { describe, expect, it, vi } from 'vitest';

import type { SupabaseSession } from '@auth/SupabaseSession';
import { createDesktopProtocolCallbackRouter } from '../../../packages/desktop/src/main/desktopProtocolCallbacks';
import {
  createDesktopSupabaseAuth,
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

describe('desktop Supabase auth', () => {
  it('opens Supabase OAuth with the desktop texra callback URI', async () => {
    const router = createDesktopProtocolCallbackRouter();
    const coordinator = createCoordinator();
    const signInWithOAuth = vi.fn(async () => ({
      data: { url: 'https://auth.example.test/start' },
      error: null,
    }));
    const openExternalUrl = vi.fn(async () => {});
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient: { auth: { signInWithOAuth } },
      secrets: {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
      openExternalUrl,
      initializeServerSideAccess: false,
    });

    await auth.signIn();

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'github',
      options: { redirectTo: 'texra://texra-ai.texra/auth-callback' },
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
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient: {
        auth: {
          signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
        },
      },
      secrets: {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
      openExternalUrl: vi.fn(async () => {}),
      onSessionChanged,
      initializeServerSideAccess: false,
    });

    router.routeUrl(
      'texra://texra-ai.texra/auth-callback#access_token=access-token&refresh_token=refresh-token',
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
    const auth = createDesktopSupabaseAuth({
      router,
      coordinator,
      oauthClient: {
        auth: {
          signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
        },
      },
      secrets: {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
      openExternalUrl: vi.fn(async () => {}),
      showErrorMessage,
      log,
      initializeServerSideAccess: false,
    });

    router.routeUrl(
      'texra://texra-ai.texra/auth-callback#access_token=access-token&refresh_token=refresh-token',
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
});
