import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initCliPlatform } from '@cli/runtime/initPlatform';
import { UsageLogService } from '@telemetry/UsageLogService';
import type { CliContext } from '@cli/runtime/cliContext';

const mocks = vi.hoisted(() => ({
  authProvider: {
    isAuthenticated: vi.fn(),
  },
  bootstrapPlatformAgentDirectories: vi.fn(),
  initializeCliSupabaseAuth: vi.fn(),
  initializeServerSideKeyAccess: vi.fn(),
  serverSideKeyService: {
    setUseIncludedModelAccess: vi.fn(),
  },
  setRuntimeSkillSources: vi.fn(),
  tryPlatform: vi.fn(),
  // Collects callbacks registered via the (mocked) lifecycle host's onShutdown
  // so a test can run them and assert the usage-log dispose was wired.
  shutdownHandlers: [] as Array<() => unknown>,
  leanAdapter: { dispose: vi.fn() },
}));

vi.mock('@agent/index/platformAgentDirectories', () => ({
  bootstrapPlatformAgentDirectories: mocks.bootstrapPlatformAgentDirectories,
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
  setOutputChannelFactory: vi.fn(),
}));

vi.mock('@platform/platform', () => ({
  initPlatform: vi.fn(),
  tryPlatform: mocks.tryPlatform,
}));

vi.mock('@skills/index', () => ({
  defaultSkillSources: vi.fn(() => []),
  setRuntimeSkillSources: mocks.setRuntimeSkillSources,
}));

vi.mock('@tools/externalToolDefs', () => ({
  setTexraCliEntrypointChecker: vi.fn(),
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
    globalState: { update: vi.fn() },
    workspaceState: {},
    storage: {},
  }),
}));

vi.mock('@cli/runtime/gitAuthor', () => ({ applyCliGitAuthorConfig: vi.fn() }));

vi.mock('@tools/lean/direct/directLspAdapter', () => ({
  createDirectLspLeanAdapter: () => mocks.leanAdapter,
}));

vi.mock('@tools/lean/leanLanguageServices', () => ({
  setLeanLanguageServices: vi.fn(),
}));

function cliContext(
  overrides: Partial<CliContext> & {
    bestEffortIncludedModelAccess?: boolean;
    installSignalHandlers?: boolean;
  } = {},
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
    mocks.tryPlatform.mockReturnValue({
      globalState: {
        update: vi.fn(),
      },
    });
    mocks.bootstrapPlatformAgentDirectories.mockResolvedValue(undefined);
    mocks.serverSideKeyService.setUseIncludedModelAccess.mockResolvedValue(
      undefined,
    );
  });

  it('wires usage logging on first platform init', async () => {
    // tryPlatform() === undefined drives the once-per-process first-init block.
    mocks.tryPlatform.mockReturnValue(undefined);
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
});
