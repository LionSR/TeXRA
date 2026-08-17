import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

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
    getConfiguredRelayToken: vi.fn(),
    getStoredSessionState: vi.fn(),
    getUserTier: vi.fn(),
    openBrowser: vi.fn(),
    pollForDeviceSession: vi.fn(),
    requestDeviceAuthorization: vi.fn(),
    setUseIncludedModelAccess: vi.fn(),
    signInWithOAuth: vi.fn(),
    startLoopbackCallbackServer: vi.fn(),
    toStorableSupabaseSession: vi.fn((session) => session),
    platform: vi.fn(),
    invalidateRemoteAgentsAfterSignOut: vi.fn(),
  };
});

vi.mock('@agent/index', () => ({
  invalidateRemoteAgentsAfterSignOut: mocks.invalidateRemoteAgentsAfterSignOut,
}));

vi.mock('@auth/config', () => ({
  DEFAULT_OAUTH_PROVIDER: 'github',
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
    getStoredSessionState: mocks.getStoredSessionState,
    getUserTier: mocks.getUserTier,
  },
}));

vi.mock('@auth/SupabaseSession', () => ({
  DEFAULT_SUPABASE_SESSION_EXPIRY_MS: 60_000,
  toStorableSupabaseSession: mocks.toStorableSupabaseSession,
}));

vi.mock('@auth/relayToken', () => ({
  RELAY_TOKEN_ENV_VAR: 'TEXRA_RELAY_TOKEN',
  fetchRelayTokenStatus: vi.fn(),
  getConfiguredRelayToken: mocks.getConfiguredRelayToken,
}));

vi.mock('@auth/serverKeys', () => ({
  getServerSideKeyService: () => ({
    clearAllCaches: mocks.clearServerKeyCaches,
    setUseIncludedModelAccess: mocks.setUseIncludedModelAccess,
  }),
}));

vi.mock('@platform/platform', () => ({
  platform: mocks.platform,
}));

vi.mock('@cli/runtime/cliContext', () => ({
  readCliEnv: () => ({}),
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

/** The device authorization every device-code path replays. */
const DEVICE_AUTHORIZATION = Object.freeze({
  device_code: 'device-code',
  expires_in: 600,
  interval: 5,
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.example/device',
});

interface FakeCallbackServer {
  readonly close: Mock<() => Promise<void>>;
  readonly redirectTo: string;
  readonly waitForSession: Mock<(signal?: AbortSignal) => Promise<unknown>>;
}

/** Arm the browser sign-in transport and hand back its loopback server. */
function stubBrowserSignIn(
  waitForSession: (signal?: AbortSignal) => Promise<unknown>,
): FakeCallbackServer {
  const callbackServer: FakeCallbackServer = {
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    redirectTo: 'http://127.0.0.1:0/callback',
    waitForSession:
      vi.fn<(signal?: AbortSignal) => Promise<unknown>>(waitForSession),
  };
  mocks.startLoopbackCallbackServer.mockResolvedValue(callbackServer);
  mocks.signInWithOAuth.mockResolvedValue({
    data: { url: 'https://auth.example/login' },
    error: null,
  });
  return callbackServer;
}

/** Arm both transports (browser and device code) to complete with `session`. */
function stubSuccessfulSignIns(session: {
  access_token: string;
}): FakeCallbackServer {
  const callbackServer = stubBrowserSignIn(async () => session);
  mocks.requestDeviceAuthorization.mockResolvedValue(DEVICE_AUTHORIZATION);
  mocks.pollForDeviceSession.mockResolvedValue(session);
  return callbackServer;
}

describe('CLI Supabase auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform.mockReturnValue({ secrets: { kind: 'platform-secrets' } });
    mocks.setUseIncludedModelAccess.mockResolvedValue(undefined);
    mocks.invalidateRemoteAgentsAfterSignOut.mockResolvedValue(undefined);
  });

  it('uses platform-owned secrets after CLI platform init', async () => {
    const platformSecrets = { kind: 'platform-secrets' };
    mocks.platform.mockReturnValue({ secrets: platformSecrets });
    const { initializeCliSupabaseAuth } = await loadSupabaseAuth();

    initializeCliSupabaseAuth();
    initializeCliSupabaseAuth();

    expect(mocks.createHostAuthCoordinator).toHaveBeenCalledTimes(1);
    expect(mocks.createHostAuthCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: platformSecrets }),
    );
  });

  it('does not store a device session when cancellation follows polling', async () => {
    const controller = new AbortController();
    mocks.requestDeviceAuthorization.mockResolvedValue(DEVICE_AUTHORIZATION);
    mocks.pollForDeviceSession.mockImplementation(async () => {
      controller.abort();
      return { access_token: 'device-token' };
    });
    const { signInCliSupabaseDeviceCode } = await loadSupabaseAuth();

    await expect(
      signInCliSupabaseDeviceCode({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(mocks.authCoordinator.storeSession).not.toHaveBeenCalled();
  });

  it('forwards interactive cancellation to both TeXRA transports', async () => {
    const controller = new AbortController();
    const callbackServer = stubSuccessfulSignIns({ access_token: 'token' });
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
    expect(mocks.pollForDeviceSession).toHaveBeenCalledWith(
      DEVICE_AUTHORIZATION,
      { signal: controller.signal },
    );
  });

  it('settles browser sign-in cancellation while its launcher remains pending', async () => {
    const controller = new AbortController();
    const callbackServer = stubBrowserSignIn(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
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
    const callbackServer = stubBrowserSignIn(async () => session);
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

  it('leaves the included-access preference to the user on sign-in', async () => {
    stubSuccessfulSignIns({ access_token: 'token' });
    const { signInCliSupabase, signInCliSupabaseDeviceCode } =
      await loadSupabaseAuth();

    await signInCliSupabase({ openBrowser: false });
    await signInCliSupabaseDeviceCode();

    // Both transports drop the caches derived from the previous credential and
    // let the next request resolve access against the new one.
    expect(mocks.clearServerKeyCaches).toHaveBeenCalledTimes(2);
    expect(mocks.setUseIncludedModelAccess).not.toHaveBeenCalled();
  });

  it('leaves the included-access preference to the user on sign-out', async () => {
    const { signOutCliSupabase } = await loadSupabaseAuth();

    await signOutCliSupabase();

    expect(mocks.clearServerKeyCaches).toHaveBeenCalledWith({
      resetQuotaFlip: true,
    });
    expect(mocks.setUseIncludedModelAccess).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'reports a service outage instead of a signed-out session',
      sessionState: 'transient',
    },
    {
      name: 'reports a rejected refresh credential as signed out',
      sessionState: 'invalid',
    },
  ])('$name', async ({ sessionState }) => {
    mocks.getStoredSessionState.mockResolvedValue(sessionState);
    const { getCliAuthProfile } = await loadSupabaseAuth();

    await expect(getCliAuthProfile()).resolves.toEqual({
      authenticated: false,
      sessionState,
    });
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
      'Local agent catalog refresh failed after sign-out: local rebuild failed',
    );
  });
});
