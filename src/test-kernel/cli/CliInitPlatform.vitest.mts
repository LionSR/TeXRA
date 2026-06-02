import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initCliPlatform } from '@cli/runtime/initPlatform';
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

function cliContext(
  overrides: Partial<CliContext> & {
    bestEffortIncludedModelAccess?: boolean;
  } = {},
): Parameters<typeof initCliPlatform>[0] {
  return {
    cwd: '/tmp/project',
    resourcesPath: '/tmp/resources',
    quietLogs: true,
    ...overrides,
  };
}

describe('CLI platform init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
