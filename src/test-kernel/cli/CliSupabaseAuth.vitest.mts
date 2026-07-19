import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GlobalStateKey } from '@shared/state/stateKeys';

const mocks = vi.hoisted(() => {
  const authCoordinator = {
    clearSession: vi.fn(),
    storeSession: vi.fn(),
  };
  return {
    authCoordinator,
    createHostAuthCoordinator: vi.fn((init: { secrets: unknown }) => ({
      ...authCoordinator,
      secrets: init.secrets,
    })),
    clearServerKeyCaches: vi.fn(),
    getCliSecrets: vi.fn(),
    openBrowser: vi.fn(),
    pollForDeviceSession: vi.fn(),
    requestDeviceAuthorization: vi.fn(),
    setUseIncludedModelAccess: vi.fn(),
    signInWithOAuth: vi.fn(),
    startLoopbackCallbackServer: vi.fn(),
    toStorableSupabaseSession: vi.fn((session) => session),
    tryPlatform: vi.fn(),
    updateGlobalState: vi.fn(),
    invalidateRemoteAgentsAfterSignOut: vi.fn(),
  };
});

vi.mock('@agent/index', () => ({
  invalidateRemoteAgentsAfterSignOut: mocks.invalidateRemoteAgentsAfterSignOut,
}));

vi.mock('@auth/config', () => ({
  DEFAULT_OAUTH_PROVIDER: 'github',
  DEFAULT_SESSION_EXPIRY_MS: 60_000,
}));

vi.mock('@auth/SupabaseAuthCoordinator', () => ({
  createHostAuthCoordinator: mocks.createHostAuthCoordinator,
}));

vi.mock('@auth/SupabaseClient', () => ({
  SupabaseClient: {
    getClient: () => ({
      auth: {
        signInWithOAuth: mocks.signInWithOAuth,
      },
    }),
    getRelayAccessToken: vi.fn(),
    getUserTier: vi.fn(),
    isAuthenticated: vi.fn(),
  },
}));

vi.mock('@auth/SupabaseSession', () => ({
  toStorableSupabaseSession: mocks.toStorableSupabaseSession,
}));

vi.mock('@auth/relayToken', () => ({
  RELAY_TOKEN_ENV_VAR: 'TEXRA_RELAY_TOKEN',
  fetchRelayTokenStatus: vi.fn(),
  getConfiguredRelayToken: vi.fn(),
}));

vi.mock('@auth/serverKeys', () => ({
  getServerSideKeyService: () => ({
    clearAllCaches: mocks.clearServerKeyCaches,
    setUseIncludedModelAccess: mocks.setUseIncludedModelAccess,
  }),
}));

vi.mock('@platform/platform', () => ({
  platform: () => ({
    globalState: {
      update: mocks.updateGlobalState,
    },
  }),
  tryPlatform: mocks.tryPlatform,
}));

vi.mock('@cli/runtime/cliContext', () => ({
  readCliEnv: () => ({}),
}));

vi.mock('@cli/runtime/cliSecrets', () => ({
  getCliSecrets: mocks.getCliSecrets,
}));

vi.mock('@cli/runtime/browser', () => ({
  openBrowser: mocks.openBrowser,
}));

vi.mock('@cli/runtime/supabaseAuthCallbackServer', () => ({
  startLoopbackCallbackServer: mocks.startLoopbackCallbackServer,
}));

vi.mock('@cli/runtime/supabaseAuthDeviceCode', () => ({
  pollForDeviceSession: mocks.pollForDeviceSession,
  requestDeviceAuthorization: mocks.requestDeviceAuthorization,
}));

async function loadSupabaseAuth() {
  vi.resetModules();
  return import('@cli/runtime/supabaseAuth');
}

describe('CLI Supabase auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryPlatform.mockReturnValue(null);
    mocks.getCliSecrets.mockReturnValue({ kind: 'cli-secrets' });
    mocks.setUseIncludedModelAccess.mockResolvedValue(undefined);
    mocks.updateGlobalState.mockResolvedValue(undefined);
    mocks.invalidateRemoteAgentsAfterSignOut.mockResolvedValue(undefined);
  });

  it('uses platform-owned secrets after CLI platform init', async () => {
    const platformSecrets = { kind: 'platform-secrets' };
    mocks.tryPlatform.mockReturnValue({ secrets: platformSecrets });
    const { initializeCliSupabaseAuth } = await loadSupabaseAuth();

    initializeCliSupabaseAuth(undefined, '/tmp/sandbox-storage');
    initializeCliSupabaseAuth();

    expect(mocks.createHostAuthCoordinator).toHaveBeenCalledTimes(1);
    expect(mocks.createHostAuthCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: platformSecrets }),
    );
    expect(mocks.getCliSecrets).not.toHaveBeenCalled();
  });

  it('does not rebind no-arg auth init to the default secrets path', async () => {
    const cliSecrets = { kind: 'sandbox-secrets' };
    mocks.getCliSecrets.mockReturnValue(cliSecrets);
    const { initializeCliSupabaseAuth } = await loadSupabaseAuth();

    initializeCliSupabaseAuth(undefined, '/tmp/sandbox-storage');
    initializeCliSupabaseAuth();

    expect(mocks.createHostAuthCoordinator).toHaveBeenCalledTimes(1);
    expect(mocks.getCliSecrets).toHaveBeenCalledWith('/tmp/sandbox-storage');
    expect(mocks.createHostAuthCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: cliSecrets }),
    );
  });

  it('clears OpenRouter routing after browser sign-in enables included access', async () => {
    const session = { access_token: 'token' };
    const callbackServer = {
      close: vi.fn().mockResolvedValue(undefined),
      redirectTo: 'http://127.0.0.1:0/callback',
      waitForSession: vi.fn().mockResolvedValue(session),
    };
    mocks.startLoopbackCallbackServer.mockResolvedValue(callbackServer);
    mocks.signInWithOAuth.mockResolvedValue({
      data: { url: 'https://auth.example/login' },
      error: null,
    });
    const { signInCliSupabase } = await loadSupabaseAuth();

    await expect(signInCliSupabase({ openBrowser: false })).resolves.toBe(
      session,
    );

    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      GlobalStateKey.USE_OPENROUTER,
      false,
    );
  });

  it('clears OpenRouter routing after device-code sign-in enables included access', async () => {
    const session = { access_token: 'device-token' };
    mocks.requestDeviceAuthorization.mockResolvedValue({
      device_code: 'device-code',
      expires_in: 600,
      interval: 5,
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://auth.example/device',
    });
    mocks.pollForDeviceSession.mockResolvedValue(session);
    const { signInCliSupabaseDeviceCode } = await loadSupabaseAuth();

    await expect(signInCliSupabaseDeviceCode()).resolves.toBe(session);

    expect(mocks.updateGlobalState).toHaveBeenCalledWith(
      GlobalStateKey.USE_OPENROUTER,
      false,
    );
  });

  it('forwards interactive cancellation to both TeXRA transports', async () => {
    const controller = new AbortController();
    const session = { access_token: 'token' };
    const callbackServer = {
      close: vi.fn().mockResolvedValue(undefined),
      redirectTo: 'http://127.0.0.1:0/callback',
      waitForSession: vi.fn().mockResolvedValue(session),
    };
    const authorization = {
      device_code: 'device-code',
      expires_in: 600,
      interval: 5,
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://auth.example/device',
    };
    mocks.startLoopbackCallbackServer.mockResolvedValue(callbackServer);
    mocks.signInWithOAuth.mockResolvedValue({
      data: { url: 'https://auth.example/login' },
      error: null,
    });
    mocks.requestDeviceAuthorization.mockResolvedValue(authorization);
    mocks.pollForDeviceSession.mockResolvedValue(session);
    const { signInCliSupabase, signInCliSupabaseDeviceCode } =
      await loadSupabaseAuth();

    await signInCliSupabase({
      openBrowser: false,
      signal: controller.signal,
    });
    await signInCliSupabaseDeviceCode({ signal: controller.signal });

    expect(callbackServer.waitForSession).toHaveBeenCalledWith(
      controller.signal,
    );
    expect(mocks.requestDeviceAuthorization).toHaveBeenCalledWith({
      signal: controller.signal,
    });
    expect(mocks.pollForDeviceSession).toHaveBeenCalledWith(authorization, {
      signal: controller.signal,
    });
  });

  it('settles browser sign-in cancellation while its launcher remains pending', async () => {
    const controller = new AbortController();
    const callbackServer = {
      close: vi.fn().mockResolvedValue(undefined),
      redirectTo: 'http://127.0.0.1:0/callback',
      waitForSession: vi.fn(
        (signal: AbortSignal | undefined) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    };
    mocks.startLoopbackCallbackServer.mockResolvedValue(callbackServer);
    mocks.signInWithOAuth.mockResolvedValue({
      data: { url: 'https://auth.example/login' },
      error: null,
    });
    mocks.openBrowser.mockReturnValue(new Promise(() => {}));
    const { signInCliSupabase } = await loadSupabaseAuth();
    const completion = signInCliSupabase({ signal: controller.signal });
    const rejection = expect(completion).rejects.toMatchObject({
      name: 'AbortError',
    });

    await vi.waitFor(() =>
      expect(callbackServer.waitForSession).toHaveBeenCalledOnce(),
    );
    controller.abort();

    await rejection;
    expect(callbackServer.close).toHaveBeenCalledOnce();
  });

  it('keeps a completed callback successful if the browser launcher later fails', async () => {
    let failBrowserLaunch!: (error: Error) => void;
    const session = { access_token: 'token' };
    const callbackServer = {
      close: vi.fn().mockResolvedValue(undefined),
      redirectTo: 'http://127.0.0.1:0/callback',
      waitForSession: vi.fn().mockResolvedValue(session),
    };
    mocks.startLoopbackCallbackServer.mockResolvedValue(callbackServer);
    mocks.signInWithOAuth.mockResolvedValue({
      data: { url: 'https://auth.example/login' },
      error: null,
    });
    mocks.openBrowser.mockReturnValue(
      new Promise((_resolve, reject) => {
        failBrowserLaunch = reject;
      }),
    );
    const { signInCliSupabase } = await loadSupabaseAuth();

    await expect(signInCliSupabase()).resolves.toBe(session);
    failBrowserLaunch(new Error('launcher exited late'));
    await Promise.resolve();

    expect(callbackServer.close).toHaveBeenCalledOnce();
  });

  it('removes cached remote agents after sign-out', async () => {
    const { signOutCliSupabase } = await loadSupabaseAuth();

    await signOutCliSupabase();

    expect(mocks.authCoordinator.clearSession).toHaveBeenCalledOnce();
    expect(mocks.invalidateRemoteAgentsAfterSignOut).toHaveBeenCalledOnce();
  });

  it('completes sign-out when the local catalog rebuild fails', async () => {
    mocks.invalidateRemoteAgentsAfterSignOut.mockRejectedValueOnce(
      new Error('local rebuild failed'),
    );
    const warn = vi.fn();
    const { initializeCliSupabaseAuth, signOutCliSupabase } =
      await loadSupabaseAuth();
    initializeCliSupabaseAuth({
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    });

    await expect(signOutCliSupabase()).resolves.toBeUndefined();

    expect(mocks.authCoordinator.clearSession).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'cli-auth',
      'Local agent catalog refresh failed after sign-out: Error: local rebuild failed',
    );
  });
});
