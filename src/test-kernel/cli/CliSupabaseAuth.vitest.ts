// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { beforeEach, describe, expect, type Mock, vi } from 'vitest';

// Local imports
import {
  testHttpClientLayer,
  testProcessRuntimeLayer,
} from '@test/support/fetchTestUtils';

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
    getStoredSessionState: vi.fn(),
    openBrowser: vi.fn(),
    pollForDeviceSession: vi.fn(),
    requestDeviceAuthorization: vi.fn(),
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
    getStoredSessionState: mocks.getStoredSessionState,
  },
}));

vi.mock('@auth/SupabaseSession', () => ({
  DEFAULT_SUPABASE_SESSION_EXPIRY_MS: 60_000,
  toStorableSupabaseSession: mocks.toStorableSupabaseSession,
}));

vi.mock('@platform/platform', () => ({
  platform: mocks.platform,
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
  // `vi.resetModules()` gives the module graph a fresh `@platform/processRuntime`
  // whose runtime the shared fake-host install never reached; the module's own
  // `initializeCliSupabaseAuth` installs the auth run edge from it.
  const [{ initProcessRuntime }, { ManagedRuntime }] = await Promise.all([
    import('@platform/processRuntime'),
    import('effect'),
  ]);
  initProcessRuntime(ManagedRuntime.make(testProcessRuntimeLayer));
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
  readonly redirectTo: string;
  readonly commitStarted: boolean;
  readonly sessionSettled: Effect.Effect<void, unknown>;
  readonly waitForSession: Effect.Effect<unknown, unknown>;
  readonly cancel: Effect.Effect<void>;
  readonly close: Effect.Effect<void, unknown>;
  readonly cancelled: Mock<() => void>;
  readonly closed: Mock<() => void>;
  /** Swap what the next `waitForSession` evaluation awaits (the commit-grace
   *  test arms the commit's completion after the abort lands). */
  readonly setWaitForSession: (effect: Effect.Effect<unknown, unknown>) => void;
}

/** Arm the browser sign-in transport and hand back its loopback server. */
function stubBrowserSignIn(init: {
  readonly waitForSession: Effect.Effect<unknown, unknown>;
  readonly sessionSettled?: Effect.Effect<void, unknown>;
  readonly commitStarted?: boolean;
}): FakeCallbackServer {
  const cancelled = vi.fn<() => void>();
  const closed = vi.fn<() => void>();
  const wait: { current: Effect.Effect<unknown, unknown> } = {
    current: init.waitForSession,
  };
  const callbackServer: FakeCallbackServer = {
    redirectTo: 'http://127.0.0.1:0/callback',
    commitStarted: init.commitStarted ?? false,
    sessionSettled: init.sessionSettled ?? Effect.void,
    waitForSession: Effect.suspend(() => wait.current),
    cancel: Effect.sync(cancelled),
    close: Effect.sync(closed),
    cancelled,
    closed,
    setWaitForSession: (effect) => {
      wait.current = effect;
    },
  };
  mocks.startLoopbackCallbackServer.mockReturnValue(
    Effect.succeed(callbackServer),
  );
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
  const callbackServer = stubBrowserSignIn({
    waitForSession: Effect.succeed(session),
  });
  mocks.requestDeviceAuthorization.mockReturnValue(
    Effect.succeed(DEVICE_AUTHORIZATION),
  );
  mocks.pollForDeviceSession.mockReturnValue(Effect.succeed(session));
  return callbackServer;
}

describe('CLI Supabase auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authCoordinator.clearSession.mockReturnValue(Effect.void);
    mocks.authCoordinator.storeSession.mockReturnValue(Effect.void);
    mocks.platform.mockReturnValue({ secrets: { kind: 'platform-secrets' } });
    mocks.invalidateRemoteAgentsAfterSignOut.mockReturnValue(Effect.void);
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

  it.effect(
    'does not store a device session when cancellation follows polling',
    () =>
      Effect.gen(function* () {
        const controller = new AbortController();
        mocks.requestDeviceAuthorization.mockReturnValue(
          Effect.succeed(DEVICE_AUTHORIZATION),
        );
        // The abort lands while the poll is settling: the fiber is interrupted
        // at that boundary and never reaches the store step.
        mocks.pollForDeviceSession.mockReturnValue(
          Effect.promise(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            controller.abort();
            return { access_token: 'device-token' };
          }),
        );
        const { signInCliSupabaseDeviceCode } = yield* Effect.promise(() =>
          loadSupabaseAuth(),
        );

        const fiber = yield* Effect.forkChild(
          signInCliSupabaseDeviceCode().pipe(
            Effect.provide(testHttpClientLayer),
          ),
        );
        // The abort fires inside the settling poll; waiting on it here
        // interrupts the sign-in fiber the way the run edge's signal wiring
        // did, before the poll's resolution can resume it.
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) =>
              controller.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            ),
        );
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);

        expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);
        expect(mocks.authCoordinator.storeSession).not.toHaveBeenCalled();
      }),
  );

  it.effect('forwards interactive cancellation to both TeXRA transports', () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const callbackServer = stubSuccessfulSignIns({ access_token: 'token' });
      let pollInterrupted = false;
      mocks.pollForDeviceSession.mockReturnValue(
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              pollInterrupted = true;
            }),
          ),
        ),
      );
      const { signInCliSupabase, signInCliSupabaseDeviceCode } =
        yield* Effect.promise(() => loadSupabaseAuth());
      yield* Effect.promise(() =>
        signInCliSupabase({
          openBrowser: false,
          signal: controller.signal,
        }),
      );
      const fiber = yield* Effect.forkChild(
        signInCliSupabaseDeviceCode().pipe(Effect.provide(testHttpClientLayer)),
      );
      // Let the sign-in fiber reach its device poll before the abort lands.
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      );
      controller.abort();
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true);
      expect(mocks.startLoopbackCallbackServer).toHaveBeenCalledOnce();
      expect(mocks.requestDeviceAuthorization).toHaveBeenCalledOnce();
      expect(mocks.pollForDeviceSession).toHaveBeenCalledWith(
        DEVICE_AUTHORIZATION,
      );
      expect(pollInterrupted).toBe(true);
    }),
  );

  it('settles browser sign-in cancellation while its launcher remains pending', async () => {
    const controller = new AbortController();
    const callbackServer = stubBrowserSignIn({
      waitForSession: Effect.never,
      sessionSettled: Effect.never,
    });
    mocks.openBrowser.mockReturnValue(new Promise(() => {}));
    const { signInCliSupabase } = await loadSupabaseAuth();
    const completion = signInCliSupabase({ signal: controller.signal });
    const rejection = expect(completion).rejects.toThrow(/interrupted/);

    controller.abort();

    await rejection;
    // Cancellation reached the transport as fiber interruption: the server
    // refuses further callbacks and the release half closed it.
    expect(callbackServer.cancelled).toHaveBeenCalledOnce();
    expect(callbackServer.closed).toHaveBeenCalledOnce();
  });

  it('settles a commit that began before cancellation despite the abort', async () => {
    const controller = new AbortController();
    const session = { access_token: 'token' };
    const callbackServer = stubBrowserSignIn({
      waitForSession: Effect.never,
      sessionSettled: Effect.never,
      commitStarted: true,
    });
    mocks.openBrowser.mockReturnValue(new Promise(() => {}));
    const { signInCliSupabase } = await loadSupabaseAuth();
    const completion = signInCliSupabase({ signal: controller.signal });

    controller.abort();
    // The commit grace re-awaits the session on a fresh fiber; arm the
    // commit's completion after the interrupted fiber settled.
    callbackServer.setWaitForSession(Effect.succeed(session));

    await expect(completion).resolves.toBe(session);
    expect(callbackServer.closed).toHaveBeenCalledOnce();
  });

  it('keeps a completed callback successful if the browser launcher later fails', async () => {
    let failBrowserLaunch!: (error: Error) => void;
    const session = { access_token: 'token' };
    const callbackServer = stubBrowserSignIn({
      waitForSession: Effect.succeed(session),
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

    expect(callbackServer.closed).toHaveBeenCalledOnce();
  });

  it('removes cached remote agents after sign-out', async () => {
    const { signOutCliSupabase } = await loadSupabaseAuth();

    await signOutCliSupabase();

    expect(mocks.authCoordinator.clearSession).toHaveBeenCalledOnce();
    expect(mocks.invalidateRemoteAgentsAfterSignOut).toHaveBeenCalledOnce();
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
    mocks.invalidateRemoteAgentsAfterSignOut.mockReturnValueOnce(
      Effect.fail(new Error('local rebuild failed')),
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
