// Third-party imports
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Exit, Fiber, Logger } from 'effect';
import { beforeAll, beforeEach, describe, expect, vi } from 'vitest';
import { AgentDirectories } from '@platform/interfaces';
import { AgentCategory } from '@shared/schemas';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';

// Local imports
import {
  createFakeWorkspaceRoots,
  FakeSecrets,
} from '@test/support/FakePlatform';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import {
  globalStorageFsTestLayer,
  nodePlatformLayer,
} from '@test/support/fsTestUtils';
import { REPO_ROOT } from '@test/support/repoScan';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { gitHubSubscriptionsLayer } from '@tools/github/subscriptionRegistries';
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
  listServers: () => [],
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
  };
});

const tempDirs = useTempDirs();

// The sign-out invalidation runs real: it rebuilds the local catalog over the
// directories the AgentDirectories service names, so the suite provides the
// bundled resources with an empty custom dir standing in for a workspace
// without custom agents.
let customAgentsDir: string;

const bundledAgentDirectories = (): {
  readonly custom: () => Effect.Effect<string, never>;
  readonly builtIn: () => Effect.Effect<string, never>;
  readonly builtInToolUse: () => Effect.Effect<string, never>;
} => ({
  custom: () => Effect.succeed(customAgentsDir),
  builtIn: () =>
    Effect.succeed(path.join(REPO_ROOT, 'packages/extension/resources/agents')),
  builtInToolUse: () =>
    Effect.succeed(
      path.join(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    ),
});

beforeAll(async () => {
  customAgentsDir = await makeTempDir('texra-cli-auth-agents-', tempDirs);
});

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
  const [{ Secrets }, { AgentResume, AppState }, { SetupPlatform }] =
    await Promise.all([
      import('@platform/secrets'),
      import('@platform/interfaces'),
      import('@tools/setup/platform'),
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
            Layer.provide(nodeSpawnerLayer),
            Layer.orDie,
          ),
        ),
      ),
      // The process services this suite's runtime carries: the auth run edge
      // reads none of them, so a member call is a test error the mock raises
      // rather than an answer from a store nothing here opened.
      Layer.mock(Secrets, { get: unreadProcessService }),
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
      // Plain in-memory ownership tables; the auth edge binds nothing.
      gitHubSubscriptionsLayer,
      SetupPlatform.layer({ host: 'cli', signIn: () => Effect.succeed(false) }),
    ),
  );
  const supabaseAuth = await import('@cli/runtime/supabaseAuth');
  // The root's runtime install is what builds the coordinator; nothing below
  // it builds one on demand.
  supabaseAuth.ensureCliSupabaseAuth(cliSecrets);
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
  });

  it('builds one account plane for the root secret store', async () => {
    const { ensureCliSupabaseAuth } = await loadSupabaseAuth();

    ensureCliSupabaseAuth(cliSecrets);
    ensureCliSupabaseAuth(cliSecrets);

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

  it.effect('removes cached remote agents after sign-out', () =>
    Effect.gen(function* () {
      const { signOutCliSupabase } = yield* Effect.promise(() =>
        loadSupabaseAuth(),
      );
      // The real invalidation rebuilds the local catalog over the directories
      // the AgentDirectories service names. The rebuild is the observable the
      // mock's call count stood in for: a fresh registry serves no agents
      // until it runs.
      const { getAgentsByCategory } = yield* Effect.promise(
        () => import('@agent/index'),
      );
      expect(getAgentsByCategory(AgentCategory.ToolUse)).toHaveLength(0);
      const { globalStorage } = createFakeWorkspaceRoots();

      yield* signOutCliSupabase().pipe(
        Effect.provide(globalStorageFsTestLayer(globalStorage)),
        Effect.provide(nodePlatformLayer),
        Effect.provide(testHttpClientLayer),
        Effect.provideService(AgentDirectories, bundledAgentDirectories()),
      );

      expect(mocks.authCoordinator.clearSession).toHaveBeenCalledOnce();
      expect(
        getAgentsByCategory(AgentCategory.ToolUse).map((entry) => entry.name),
      ).toContain('assistant');
    }),
  );

  it.effect.each([
    {
      name: 'reports a service outage instead of a signed-out session',
      sessionState: 'transient',
    },
    {
      name: 'reports a rejected refresh credential as signed out',
      sessionState: 'invalid',
    },
  ])('$name', ({ sessionState }) =>
    Effect.gen(function* () {
      mocks.authCoordinator.getStoredSessionState.mockReturnValue(
        Effect.succeed(sessionState),
      );
      const { getCliAuthProfile } = yield* Effect.promise(() =>
        loadSupabaseAuth(),
      );

      expect(yield* getCliAuthProfile()).toEqual({
        authenticated: false,
        sessionState,
      });
    }),
  );

  it.effect('completes sign-out when the local catalog rebuild fails', () =>
    Effect.gen(function* () {
      const { signOutCliSupabase } = yield* Effect.promise(() =>
        loadSupabaseAuth(),
      );
      const warnings: unknown[] = [];
      const capture = Logger.make((options) => {
        if (options.logLevel === 'Warn') warnings.push(options.message);
      });
      const { globalStorage } = createFakeWorkspaceRoots();
      // The invalidation owns the best-effort guard, defects included: the
      // directory port dying mid-rebuild must not fail sign-out.
      const rebuildDies = {
        custom: () => Effect.die(new Error('local rebuild failed')),
        builtIn: () => Effect.die(new Error('local rebuild failed')),
        builtInToolUse: () => Effect.die(new Error('local rebuild failed')),
      };

      expect(
        yield* signOutCliSupabase().pipe(
          Effect.provide(globalStorageFsTestLayer(globalStorage)),
          Effect.provide(nodePlatformLayer),
          Effect.provide(testHttpClientLayer),
          Effect.provideService(AgentDirectories, rebuildDies),
          Effect.withLogger(capture),
        ),
      ).toBeUndefined();

      expect(mocks.authCoordinator.clearSession).toHaveBeenCalledOnce();
      expect(warnings).toContainEqual([
        'Local agent catalog rebuild failed after sign-out: local rebuild failed',
      ]);
    }),
  );
});
