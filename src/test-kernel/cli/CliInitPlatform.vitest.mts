// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { UsageLogService } from '@telemetry/UsageLogService';
import { resolveAndResumeStream } from '@agent/runtime/resolveAndResumeStream';
import { setCliAgentResumeHandler } from '@cli/runtime/agentResume';
import { initCliPlatform } from '@cli/runtime/initPlatform';
import { setOutputChannelFactory } from '@logger/logUtils';
import type { StreamTabId } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { getSetupPlatform } from '@tools/setup/platform';

type SignalSpyEvent = 'SIGINT' | 'SIGTERM';

/** Records every SIGINT/SIGTERM registration without touching the live
 *  process's real listeners, distinguishing `process.once` (the platform
 *  handler) from `process.on` (the TUI's own handler, installed once Ink
 *  mounts) so a test can assert exactly who owns the signal. Restore only
 *  these two spies (not `vi.restoreAllMocks()`) — this file's shared `mocks.*`
 *  functions are plain `vi.fn()`s, not `vi.spyOn` spies, so a sweeping
 *  restore would strip their `vi.hoisted` implementations instead of
 *  reverting them. */
function spyOnSignalRegistration(): {
  registered: Array<{ event: SignalSpyEvent; kind: 'once' | 'on' | 'removed' }>;
  restore: () => void;
} {
  const registered: Array<{
    event: SignalSpyEvent;
    kind: 'once' | 'on' | 'removed';
  }> = [];
  const onceSpy = vi.spyOn(process, 'once').mockImplementation(((
    event: string | symbol,
    _listener: (...args: unknown[]) => void,
  ) => {
    if (event === 'SIGINT' || event === 'SIGTERM') {
      registered.push({ event, kind: 'once' });
    }
    return process;
  }) as typeof process.once);
  const onSpy = vi.spyOn(process, 'on').mockImplementation(((
    event: string | symbol,
    _listener: (...args: unknown[]) => void,
  ) => {
    if (event === 'SIGINT' || event === 'SIGTERM') {
      registered.push({ event, kind: 'on' });
    }
    return process;
  }) as typeof process.on);
  const removeListenerSpy = vi
    .spyOn(process, 'removeListener')
    .mockImplementation(((
      event: string | symbol,
      _listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGINT' || event === 'SIGTERM') {
        registered.push({ event, kind: 'removed' });
      }
      return process;
    }) as typeof process.removeListener);
  return {
    registered,
    restore: () => {
      onceSpy.mockRestore();
      onSpy.mockRestore();
      removeListenerSpy.mockRestore();
    },
  };
}

const mocks = vi.hoisted(() => ({
  authProvider: {
    isAuthenticated: vi.fn(),
    canAccessRemoteAgentCatalog: vi.fn(),
  },
  signInCliSupabase: vi.fn(),
  bootstrapNodeAgentDirectories: vi.fn(),
  createPlatformAgentDirectories: vi.fn(() => ({
    custom: vi.fn(),
    builtIn: vi.fn(),
    builtInToolUse: vi.fn(),
  })),
  createNodePlatform: vi.fn(() => ({})),
  initializeCliSupabaseAuth: vi.fn(),
  initializeNodeGoalPrompts: vi.fn(),
  initializeNodeRuntimeSkills: vi.fn(),
  initNodeAgentRuntime: vi.fn(),
  initializeServerSideKeyAccess: vi.fn(),
  serverSideKeyService: {
    setUseIncludedModelAccess: vi.fn(),
  },
  getCliSecrets: vi.fn(() => ({ kind: 'cli-secrets' })),
  invalidateModelOptionsCache: vi.fn(),
  tryPlatform: vi.fn(),
  // Collects callbacks registered via the (mocked) lifecycle host's onShutdown
  // so a test can run them and assert the usage-log dispose was wired.
  shutdownHandlers: [] as Array<() => unknown>,
}));

vi.mock('@agent/index/platformAgentDirectories', () => ({
  createPlatformAgentDirectories: mocks.createPlatformAgentDirectories,
}));

vi.mock('@auth/serverKeys', () => ({
  getServerSideKeyService: () => mocks.serverSideKeyService,
  initializeServerSideKeyAccess: mocks.initializeServerSideKeyAccess,
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => mocks.authProvider,
  initializeCliSupabaseAuth: mocks.initializeCliSupabaseAuth,
  signInCliSupabase: mocks.signInCliSupabase,
}));

vi.mock('@logger/logUtils', () => ({
  createChannelWriter: vi.fn(() => vi.fn()),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  initialize: vi.fn(),
  setOutputChannelFactory: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@model/computeModelOptions', () => ({
  invalidateModelOptionsCache: mocks.invalidateModelOptionsCache,
}));

vi.mock('@platform/platform', () => ({
  initPlatform: vi.fn(),
  tryPlatform: mocks.tryPlatform,
  tryGlobalState: () => mocks.tryPlatform()?.globalState,
  platform: () => ({ config: { get: (_key: string, def: unknown) => def } }),
}));

// initCliPlatform delegates shared Node-host construction and runtime wiring to
// nodeHost; stub it so the test exercises only the CLI-specific wiring and
// feature registration does not run twice across cases.
vi.mock('@platform/defaults/nodeHost', () => ({
  bootstrapNodeAgentDirectories: mocks.bootstrapNodeAgentDirectories,
  createNodePlatform: mocks.createNodePlatform,
  initNodeAgentRuntime: mocks.initNodeAgentRuntime,
  initializeNodeGoalPrompts: mocks.initializeNodeGoalPrompts,
  initializeNodeRuntimeSkills: mocks.initializeNodeRuntimeSkills,
}));

vi.mock('@telemetry/UsageLogService', () => ({
  UsageLogService: { initialize: vi.fn(), dispose: vi.fn() },
}));

// First-init dependencies: only exercised when tryPlatform() returns undefined.
// The existing auth-probe tests keep tryPlatform truthy and skip this block, so
// these stubs are inert there and only drive the "first init" test below.
vi.mock('@platform/defaults/lifecycleHost', () => ({
  createLifecycleHost: () => ({
    onShutdown: (_phase: unknown, callback: () => unknown) => {
      mocks.shutdownHandlers.push(callback);
      return { dispose: vi.fn() };
    },
    runShutdown: vi.fn(),
  }),
}));

vi.mock('@platform/defaults/jsonStore', () => ({
  JsonStore: { open: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@platform/defaults/jsonConfigProvider', () => ({
  JsonConfigProvider: vi.fn(),
}));

vi.mock('@platform/defaults/nodeFilesystem', () => ({ nodeFilesystem: {} }));

vi.mock('@platform/defaults/nodeWorkspace', () => ({
  createNodeWorkspace: vi.fn(() => ({})),
}));

vi.mock('@cli/runtime/cliStateStores', () => ({
  createCliStateStores: vi.fn().mockResolvedValue({
    globalState: { get: vi.fn(), update: vi.fn() },
    workspaceState: {},
    storage: { getGlobalStoragePath: () => '/tmp/texra-global' },
  }),
}));

vi.mock('@cli/runtime/cliSecrets', () => ({
  getCliSecrets: mocks.getCliSecrets,
}));

vi.mock('@cli/runtime/gitAuthor', () => ({ applyCliGitAuthorConfig: vi.fn() }));

vi.mock('@tools/lean/direct/directLspAdapter', () => ({
  registerDirectLeanLanguageServices: vi.fn(),
}));

function cliContext(
  overrides: Partial<Parameters<typeof initCliPlatform>[0]> = {},
): Parameters<typeof initCliPlatform>[0] {
  return {
    cwd: '/tmp/project',
    resourcesPath: '/tmp/resources',
    version: '0.0.0-test',
    quietLogs: true,
    skillSourceOptions: {},
    ...overrides,
  };
}

describe('CLI platform init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shutdownHandlers.length = 0;
    mocks.tryPlatform.mockReset();
    mocks.tryPlatform.mockReturnValue({
      globalState: {
        get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
        update: vi.fn(),
      },
    });
    mocks.bootstrapNodeAgentDirectories.mockResolvedValue(undefined);
    mocks.authProvider.canAccessRemoteAgentCatalog.mockResolvedValue(false);
    mocks.serverSideKeyService.setUseIncludedModelAccess.mockResolvedValue(
      undefined,
    );
  });

  it('uses the configured storage root for CLI secrets', async () => {
    mocks.tryPlatform.mockReturnValueOnce(undefined);
    mocks.authProvider.isAuthenticated.mockResolvedValue(false);

    await initCliPlatform(
      cliContext({
        installSignalHandlers: false,
        storageRoot: '/tmp/texra-storage-root',
      }),
    );

    expect(mocks.getCliSecrets).toHaveBeenCalledWith('/tmp/texra-storage-root');
    expect(mocks.createNodePlatform).toHaveBeenCalledOnce();
    expect(mocks.initNodeAgentRuntime).toHaveBeenCalledOnce();
    expect(mocks.initializeCliSupabaseAuth).toHaveBeenCalledWith(
      expect.anything(),
      '/tmp/texra-storage-root',
    );
  });

  it('wires usage logging on first platform init', async () => {
    // tryPlatform() === undefined drives the once-per-process first-init block.
    const globalState = {
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
      update: vi.fn(),
    };
    mocks.tryPlatform.mockReturnValue({ globalState });
    mocks.tryPlatform.mockReturnValueOnce(undefined);
    mocks.authProvider.isAuthenticated.mockResolvedValue(false);

    await initCliPlatform(
      cliContext({ version: '1.2.3', installSignalHandlers: false }),
    );

    expect(vi.mocked(UsageLogService.initialize)).toHaveBeenCalledWith(
      {},
      '1.2.3',
      'cli',
    );

    // The dispose handler must be registered on shutdown so queued entries flush.
    expect(vi.mocked(UsageLogService.dispose)).not.toHaveBeenCalled();
    for (const handler of mocks.shutdownHandlers) await handler();
    expect(vi.mocked(UsageLogService.dispose)).toHaveBeenCalled();
  });

  it('marks the operator-terminal console sink as trusted', async () => {
    mocks.authProvider.isAuthenticated.mockResolvedValue(false);

    await initCliPlatform(cliContext({ quietLogs: false }));

    expect(vi.mocked(setOutputChannelFactory)).toHaveBeenCalledWith(null, {
      trusted: true,
    });
  });

  it('installs a CLI agent resume port that delegates to the active handler', async () => {
    mocks.tryPlatform.mockReturnValueOnce(undefined);
    mocks.authProvider.isAuthenticated.mockResolvedValue(false);

    await initCliPlatform(cliContext({ installSignalHandlers: false }));

    type NodePlatformOptions = {
      readonly agentResume: {
        tryResumeStream(streamId: StreamTabId): Promise<boolean>;
        isResumeInFlight(streamId: StreamTabId): boolean;
      };
    };
    const createNodePlatformCalls = mocks.createNodePlatform.mock
      .calls as unknown as Array<[NodePlatformOptions]>;
    const nodePlatformOptions = createNodePlatformCalls[0]?.[0];
    expect(nodePlatformOptions?.agentResume).toBeDefined();
    if (!nodePlatformOptions) throw new Error('expected node platform options');

    const streamId = 'stream:cli-resume' as StreamTabId;
    let releaseResumeState!: () => void;
    const pendingResumeState = new Promise<undefined>((resolve) => {
      releaseResumeState = () => resolve(undefined);
    });
    const pendingResume = resolveAndResumeStream(streamId, {
      runtimeHost: { emit: vi.fn() },
      streamStatus: { isActiveOrResuming: () => false },
      resolveResumeState: () => pendingResumeState,
      resumeToolUseSnapshot: vi.fn(async () => false),
      executeWorkflow: vi.fn(async () => {}),
    });

    expect(nodePlatformOptions.agentResume.isResumeInFlight(streamId)).toBe(
      false,
    );

    const tryResumeStream = vi.fn(async () => true);
    const dispose = setCliAgentResumeHandler({
      tryResumeStream,
    });

    try {
      await expect(
        nodePlatformOptions.agentResume.tryResumeStream(streamId),
      ).resolves.toBe(true);
      expect(tryResumeStream).toHaveBeenCalledWith(streamId);
      expect(nodePlatformOptions.agentResume.isResumeInFlight(streamId)).toBe(
        true,
      );
    } finally {
      dispose();
      releaseResumeState();
      await pendingResume;
    }
  });

  it('bootstraps bundled agents with the CLI version store', async () => {
    const globalState = {
      get: vi.fn((key: string, defaultValue: unknown) =>
        key === GlobalStateKey.CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION
          ? '1.2.2'
          : defaultValue,
      ),
      update: vi.fn().mockResolvedValue(undefined),
    };
    mocks.tryPlatform.mockReturnValue({ globalState });
    mocks.authProvider.isAuthenticated.mockResolvedValueOnce(false);

    await initCliPlatform(
      cliContext({
        resourcesPath: '/tmp/resources-versioned',
        version: '1.2.3',
      }),
    );

    expect(mocks.initializeNodeGoalPrompts).toHaveBeenCalledWith(
      '/tmp/resources-versioned',
    );
    expect(mocks.bootstrapNodeAgentDirectories).toHaveBeenCalledWith({
      channel: 'cli',
      resourcesPath: '/tmp/resources-versioned',
      currentVersion: '1.2.3',
      versionStateKey: GlobalStateKey.CLI_BUNDLED_AGENTS_LAST_KNOWN_VERSION,
    });
  });

  it('surfaces included-access auth probe failures by default', async () => {
    mocks.authProvider.isAuthenticated.mockRejectedValueOnce(
      new Error('auth offline'),
    );

    await expect(initCliPlatform(cliContext())).rejects.toThrow('auth offline');
    expect(
      mocks.serverSideKeyService.setUseIncludedModelAccess,
    ).not.toHaveBeenCalled();
  });

  it('lets launcher init treat auth probe failures as no included access', async () => {
    mocks.authProvider.isAuthenticated.mockRejectedValueOnce(
      new Error('auth offline'),
    );

    await expect(
      initCliPlatform(cliContext({ bestEffortIncludedModelAccess: true })),
    ).resolves.toBeUndefined();
    expect(
      mocks.serverSideKeyService.setUseIncludedModelAccess,
    ).toHaveBeenCalledWith(false);
  });

  it('keeps included access off when OpenRouter routing is enabled', async () => {
    const globalState = {
      get: vi.fn((key: string, defaultValue: unknown) =>
        key === GlobalStateKey.USE_OPENROUTER ? true : defaultValue,
      ),
      update: vi.fn(),
    };
    mocks.tryPlatform.mockReturnValue({ globalState });
    mocks.authProvider.isAuthenticated.mockResolvedValueOnce(true);

    await initCliPlatform(cliContext());

    expect(mocks.authProvider.isAuthenticated).not.toHaveBeenCalled();
    expect(
      mocks.serverSideKeyService.setUseIncludedModelAccess,
    ).toHaveBeenCalledWith(false);
  });

  it('clears OpenRouter when startup explicitly selects included access', async () => {
    const globalState = {
      get: vi.fn((key: string, defaultValue: unknown) =>
        key === GlobalStateKey.USE_OPENROUTER ? true : defaultValue,
      ),
      update: vi.fn().mockResolvedValue(undefined),
    };
    mocks.tryPlatform.mockReturnValue({ globalState });
    mocks.authProvider.isAuthenticated.mockResolvedValueOnce(true);

    await initCliPlatform(cliContext({ apiMode: 'included' }));

    expect(globalState.update).toHaveBeenCalledWith(
      GlobalStateKey.USE_OPENROUTER,
      false,
    );
    expect(mocks.invalidateModelOptionsCache).toHaveBeenCalledOnce();
    expect(mocks.authProvider.isAuthenticated).toHaveBeenCalledOnce();
    expect(
      mocks.serverSideKeyService.setUseIncludedModelAccess,
    ).toHaveBeenCalledWith(true);
  });

  it('registers CLI runtime skill sources through the shared Node host helper', async () => {
    mocks.authProvider.isAuthenticated.mockResolvedValueOnce(false);

    await initCliPlatform(
      cliContext({
        skillSourceOptions: {
          includeInterop: true,
          additionalPaths: ['vendor/skills'],
        },
      }),
    );

    expect(mocks.initializeNodeRuntimeSkills).toHaveBeenCalledWith({
      cwd: '/tmp/project',
      resourcesPath: '/tmp/resources',
      skillSourceOptions: {
        includeInterop: true,
        additionalPaths: ['vendor/skills'],
      },
    });
  });

  it('wires setup sign-in to the existing CLI login implementation', async () => {
    mocks.authProvider.isAuthenticated.mockResolvedValue(false);
    mocks.authProvider.canAccessRemoteAgentCatalog.mockResolvedValue(true);
    mocks.signInCliSupabase.mockResolvedValue({ account: { label: 'User' } });

    await initCliPlatform(cliContext());

    await expect(getSetupPlatform().auth.signIn?.()).resolves.toBe(true);
    expect(mocks.signInCliSupabase).toHaveBeenCalledOnce();
    expect(mocks.signInCliSupabase).toHaveBeenCalledWith({ openBrowser: true });
  });
});

// Regression for the HIGH-severity chat TUI signal race: `texra chat`/
// `orchestrate`/`setup`/`resume` are the REAL interactive entry points — all
// four eventually hand control to runChatTui.tsx's `runChat()`, which installs
// its own SIGINT/SIGTERM handlers once Ink mounts and owns teardown from
// there (terminal-mode restore, persistence drain, then the same
// runCliPlatformShutdownSequence the platform handler would have run). Before
// this fix, every one of those call sites also called plain `initCliPlatform`
// (default `installSignalHandlers: true`), so the platform's own
// `process.once('SIGINT'/'SIGTERM', ...)` handler installed too — two
// independent async shutdown chains reacting to the same signal, racing on
// whose `process.exit()` wins and leaving teardown order unspecified.
//
// `initInteractiveCliPlatform` does NOT suppress the platform handler up
// front (a signal during onboarding/model-resolution/the orchestration
// launcher still needs a graceful handler); instead
// `handOffCliShutdownSignalHandlers()` removes it right at the point the TUI
// installs its own pair, so the two sets are never simultaneously live. These
// suites use `installCliShutdownSignalHandlers`'s idempotent, module-level
// `shutdownHandlersInstalled` flag, so each test needs a freshly-imported
// module (`vi.resetModules()` + dynamic import) to observe installation from
// a clean slate.
describe('CLI platform interactive signal ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryPlatform.mockReset();
    mocks.bootstrapNodeAgentDirectories.mockResolvedValue(undefined);
    mocks.authProvider.isAuthenticated.mockResolvedValue(false);
  });

  it('initInteractiveCliPlatform keeps the platform handler live until an explicit handoff', async () => {
    vi.resetModules();
    const { registered, restore } = spyOnSignalRegistration();
    try {
      mocks.tryPlatform.mockReturnValueOnce(undefined);
      mocks.tryPlatform.mockReturnValue({
        globalState: { get: vi.fn(), update: vi.fn() },
      });

      const { initInteractiveCliPlatform, handOffCliShutdownSignalHandlers } =
        await import('@cli/runtime/initPlatform');
      // The await-suspension point from the finding: runChat() awaits this
      // init call, then onboarding/model resolution, before Ink ever mounts
      // and installs its own handlers below. Unlike the pre-handoff-design
      // fix, the platform handler stays registered for that whole window —
      // a signal there still gets a graceful shutdown.
      await initInteractiveCliPlatform(cliContext());
      expect(registered).toEqual([
        { event: 'SIGINT', kind: 'once' },
        { event: 'SIGTERM', kind: 'once' },
      ]);

      // The TUI is about to mount (runChatTui.tsx) — it hands off ownership
      // immediately before installing its own handlers.
      handOffCliShutdownSignalHandlers();
      expect(registered).toEqual([
        { event: 'SIGINT', kind: 'once' },
        { event: 'SIGTERM', kind: 'once' },
        { event: 'SIGINT', kind: 'removed' },
        { event: 'SIGTERM', kind: 'removed' },
      ]);

      process.on('SIGINT', () => undefined);
      process.on('SIGTERM', () => undefined);

      expect(registered.slice(-2)).toEqual([
        { event: 'SIGINT', kind: 'on' },
        { event: 'SIGTERM', kind: 'on' },
      ]);
    } finally {
      restore();
    }
  });

  it('a headless call site (plain initCliPlatform) keeps the platform handler installed', async () => {
    vi.resetModules();
    const { registered, restore } = spyOnSignalRegistration();
    try {
      mocks.tryPlatform.mockReturnValueOnce(undefined);
      mocks.tryPlatform.mockReturnValue({
        globalState: { get: vi.fn(), update: vi.fn() },
      });

      const { initCliPlatform: freshInitCliPlatform } =
        await import('@cli/runtime/initPlatform');
      await freshInitCliPlatform(cliContext());

      expect(registered).toEqual([
        { event: 'SIGINT', kind: 'once' },
        { event: 'SIGTERM', kind: 'once' },
      ]);
    } finally {
      restore();
    }
  });

  it('documents the race a forgotten installSignalHandlers:false would reintroduce', async () => {
    vi.resetModules();
    const { registered, restore } = spyOnSignalRegistration();
    try {
      mocks.tryPlatform.mockReturnValueOnce(undefined);
      mocks.tryPlatform.mockReturnValue({
        globalState: { get: vi.fn(), update: vi.fn() },
      });

      // A call site that used plain initCliPlatform (pre-fix behavior at
      // every interactive entry point) installs the platform handler...
      const { initCliPlatform: freshInitCliPlatform } =
        await import('@cli/runtime/initPlatform');
      await freshInitCliPlatform(cliContext());
      // ...and once the TUI mounts and claims the signals too, BOTH owners
      // are registered for the same signal — the exact race from the
      // finding, reproduced against real production wiring.
      process.on('SIGINT', () => undefined);
      process.on('SIGTERM', () => undefined);

      expect(registered.filter((r) => r.event === 'SIGINT')).toHaveLength(2);
      expect(registered.filter((r) => r.event === 'SIGTERM')).toHaveLength(2);
    } finally {
      restore();
    }
  });
});
