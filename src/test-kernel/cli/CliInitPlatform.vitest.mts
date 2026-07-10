import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsageLogService } from '@telemetry/UsageLogService';
import { resolveAndResumeStream } from '@agent/runtime/resolveAndResumeStream';
import { setCliAgentResumeHandler } from '@cli/runtime/agentResume';
import { initCliPlatform } from '@cli/runtime/initPlatform';
import type { StreamTabId } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';

const mocks = vi.hoisted(() => ({
  authProvider: {
    isAuthenticated: vi.fn(),
  },
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
}));

vi.mock('@logger/logUtils', () => ({
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
});
