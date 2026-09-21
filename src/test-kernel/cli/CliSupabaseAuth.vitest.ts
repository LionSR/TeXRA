// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';

// Local imports
import { FakeSecrets } from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import {
  globalStorageFsTestLayer,
  nodePlatformLayer,
} from '@test/support/fsTestUtils';
import {
  LeanLanguageServices,
  type LeanLanguageServicesShape,
} from '@tools/lean/leanLanguageServices';

/**
 * The secret store the CLI composition root owns. Every load below
 * initializes the auth coordinator with it, exactly as `initCliPlatform`
 * does, so the coordinator is keyed on one store for the whole suite.
 */
const cliSecrets = new FakeSecrets();

/** The synchronous process-service members `Layer.mock` cannot stub itself. */
const unreadProcessService = (): never => {
  throw new Error('The CLI auth edge reads no process services.');
};
const unavailableLeanLanguageServices: LeanLanguageServicesShape = {
  executeFileCommand: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  getGoalState: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  getTermGoal: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  getHoverInfo: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  fetchDiagnosticsForFile: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  navigateToFirstError: () => Effect.void,
  executeProjectCommand: () =>
    Effect.die(
      new Error('LeanLanguageServices is not configured in this test'),
    ),
  stopSessionsForRun: () => Effect.void,
};

const mocks = vi.hoisted(() => {
  const authCoordinator = {
    clearSession: vi.fn(),
    storeSession: vi.fn(),
    getStoredSessionState: vi.fn(),
    loadSession: vi.fn(),
  };
  return {
    authCoordinator,
    createSupabaseAuth: vi.fn(),
    openBrowser: vi.fn(),
    pollForDeviceSession: vi.fn(),
    requestDeviceAuthorization: vi.fn(),
    signInWithOAuth: vi.fn(),
    toStorableSupabaseSession: vi.fn((session) => session),
    platform: vi.fn(),
    invalidateRemoteAgentsAfterSignOut: vi.fn(),
  };
});

vi.mock('@agent/index', () => ({
  invalidateRemoteAgentsAfterSignOut: mocks.invalidateRemoteAgentsAfterSignOut,
}));

vi.mock('@auth/config', () => ({
  AUTH_CALLBACK_TIMEOUT_MS: 600_000,
  DEFAULT_OAUTH_PROVIDER: 'github',
}));

vi.mock('@auth/SupabaseAuth', async (importActual) => {
  const actual = await importActual<typeof import('@auth/SupabaseAuth')>();
  const { fakeSupabaseAuth } = await import('@test/support/fakeSupabaseAuth');
  return {
    ...actual,
    createSupabaseAuth: (init: { secrets: unknown }) => {
      mocks.createSupabaseAuth(init);
      return Effect.succeed(
        fakeSupabaseAuth({
          client: {
            auth: { signInWithOAuth: mocks.signInWithOAuth },
          } as never,
          coordinator: mocks.authCoordinator as never,
        }),
      );
    },
  };
});

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
  loopbackCallbackTransport: () => {
    throw new Error('The loopback transport is not armed in this suite.');
  },
}));

vi.mock('@cli/runtime/supabaseAuthDeviceCode', () => ({
  pollForDeviceSession: mocks.pollForDeviceSession,
  requestDeviceAuthorization: mocks.requestDeviceAuthorization,
}));

async function loadSupabaseAuth() {
  vi.resetModules();
  const { Layer, ManagedRuntime } = await import('effect');
  const [
    { inquiryRecordsLayer },
    { globalDatabaseLayer },
    { ProcessIdentity },
    { processOwnerId },
  ] = await Promise.all([
    import('@controllers/session/inquiryRecords'),
    import('@controllers/session/Database'),
    import('@shared/session/sessionEvents'),
    import('@platform/defaults/nodeProcesses'),
  ]);
  const [
    { Secrets },
    { AgentResume, AppState },
    { SetupPlatform },
    { ToolInjections },
  ] = await Promise.all([
    import('@platform/secrets'),
    import('@platform/interfaces'),
    import('@tools/setup/platform'),
    import('@agent/runtime/toolInjection'),
  ]);
  const { SupabaseAuth, unavailableSupabaseAuth } =
    await import('@auth/SupabaseAuth');
  const { LanguageModel } = await import('@platform/languageModel');
  const { createFakeWorkspaceRoots } =
    await import('@test/support/FakePlatform');
  const { globalStorage } = createFakeWorkspaceRoots();
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      testHttpClientLayer,
      nodePlatformLayer,
      globalStorageFsTestLayer(globalStorage),
      Layer.mock(UpdateCheckRecords, {}),
      Layer.mock(LeanLanguageServices, unavailableLeanLanguageServices),
      inquiryRecordsLayer.pipe(
        Layer.provideMerge(
          globalDatabaseLayer(globalStorage).pipe(
            Layer.provide(ProcessIdentity.layer(processOwnerId(undefined))),
            Layer.orDie,
          ),
        ),
      ),
      // The process services this suite's runtime carries: the auth run edge
      // reads none of them, so a member call is a test error the mock raises
      // rather than an answer from a store nothing here opened.
      Layer.mock(Secrets, { getEnv: unreadProcessService }),
      Layer.mock(AppState, { update: unreadProcessService }),
      // The account plane the module under test serves is its own module
      // state; this one only satisfies the process-runtime type.
      SupabaseAuth.layer(unavailableSupabaseAuth()),
      Layer.mock(LanguageModel, {
        isAvailable: unreadProcessService,
        selectModels: unreadProcessService,
        onDidChange: unreadProcessService,
      }),
      Layer.mock(AgentResume, { tryResumeRun: unreadProcessService }),
      SetupPlatform.layer({ host: 'cli', signIn: () => Effect.succeed(false) }),
      ToolInjections.layer([]),
    ),
  );
  const supabaseAuth = await import('@cli/runtime/supabaseAuth');
  // The root's init is what builds the coordinator; nothing below it builds
  // one on demand.
  supabaseAuth.initializeCliSupabaseAuth(cliSecrets);
  return { ...supabaseAuth, runtime };
}

/** The device authorization every device-code path replays. */
const DEVICE_AUTHORIZATION = Object.freeze({
  device_code: 'device-code',
  expires_in: 600,
  interval: 5,
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://auth.example/device',
});

describe('CLI Supabase auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authCoordinator.clearSession.mockReturnValue(Effect.void);
    mocks.authCoordinator.storeSession.mockReturnValue(Effect.void);
    mocks.authCoordinator.getStoredSessionState.mockReturnValue(
      Effect.succeed('none'),
    );
    mocks.authCoordinator.loadSession.mockReturnValue(Effect.succeed(null));
    mocks.platform.mockReturnValue({ secrets: { kind: 'platform-secrets' } });
    mocks.invalidateRemoteAgentsAfterSignOut.mockReturnValue(Effect.void);
  });

  it('builds one account plane for the root secret store', async () => {
    const { initializeCliSupabaseAuth } = await loadSupabaseAuth();

    initializeCliSupabaseAuth(cliSecrets);
    initializeCliSupabaseAuth(cliSecrets);

    expect(mocks.createSupabaseAuth).toHaveBeenCalledTimes(1);
    expect(mocks.createSupabaseAuth).toHaveBeenCalledWith(
      expect.objectContaining({ secrets: cliSecrets }),
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

  it('removes cached remote agents after sign-out', async () => {
    const { runtime, signOutCliSupabase } = await loadSupabaseAuth();

    await runtime.runPromise(signOutCliSupabase());

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
    mocks.authCoordinator.getStoredSessionState.mockReturnValue(
      Effect.succeed(sessionState),
    );
    const { getCliAuthProfile } = await loadSupabaseAuth();

    await expect(Effect.runPromise(getCliAuthProfile())).resolves.toEqual({
      authenticated: false,
      sessionState,
    });
  });

  it('completes sign-out when the local catalog rebuild fails', async () => {
    mocks.invalidateRemoteAgentsAfterSignOut.mockReturnValueOnce(
      Effect.fail(new Error('local rebuild failed')),
    );
    const warn = vi.fn();
    const { initializeCliSupabaseAuth, runtime, signOutCliSupabase } =
      await loadSupabaseAuth();
    initializeCliSupabaseAuth(cliSecrets, {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    });

    await expect(
      runtime.runPromise(signOutCliSupabase()),
    ).resolves.toBeUndefined();

    expect(mocks.authCoordinator.clearSession).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      'cli-auth',
      'Local agent catalog refresh failed after sign-out: local rebuild failed',
    );
  });
});
