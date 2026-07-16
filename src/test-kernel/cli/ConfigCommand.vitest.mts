import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { InvalidAgentTeamError } from '@agent/index';

const mocks = vi.hoisted(() => ({
  clearDefaultTeam: vi.fn(),
  getVisibleAgents: vi.fn(),
  initLocalCliPlatform: vi.fn(),
  readCliAgentRoster: vi.fn(),
  setAll: vi.fn(),
  setCustom: vi.fn(),
  setDefaultTeam: vi.fn(),
  setEnabledAgentKeys: vi.fn(),
  setInherited: vi.fn(),
  setTeam: vi.fn(),
  setWorkspaceCliChatAgent: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/initPlatform')>()),
  initLocalCliPlatform: mocks.initLocalCliPlatform,
}));

vi.mock('@cli/runtime/agentRoster', () => ({
  cliAgentRosterController: () => ({
    clearDefaultTeam: mocks.clearDefaultTeam,
    getVisibleAgents: mocks.getVisibleAgents,
    setAll: mocks.setAll,
    setCustom: mocks.setCustom,
    setDefaultTeam: mocks.setDefaultTeam,
    setEnabledAgentKeys: mocks.setEnabledAgentKeys,
    setInherited: mocks.setInherited,
    setTeam: mocks.setTeam,
  }),
  formatCliAgentRoster: () => 'Agent roster',
  readCliAgentRoster: mocks.readCliAgentRoster,
}));

vi.mock('@cli/runtime/cliConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/cliConfig')>()),
  setWorkspaceCliChatAgent: mocks.setWorkspaceCliChatAgent,
}));

const { runCli } = await import('@cli/commands/root');

describe('CLI config command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initLocalCliPlatform.mockResolvedValue(undefined);
    mocks.getVisibleAgents.mockReturnValue([
      {
        category: 'toolUse',
        source: 'builtInToolUse',
        name: 'assistant',
        path: '/agents/assistant.yaml',
      },
    ]);
    mocks.readCliAgentRoster.mockResolvedValue({
      selection: { kind: 'all' },
      effectiveSelection: { kind: 'all' },
      workflowAgentKeys: [],
      toolUseAgentKeys: [],
      unresolvedNames: [],
    });
    stdoutSpy = spyOnStreamWrite(process.stdout);
    stderrSpy = spyOnStreamWrite(process.stderr);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it.each([
    ['workflow', '--workflow', 'builtInWorkflow:write,custom:review'],
    ['toolUse', '--tool-use', 'builtInToolUse:assistant,custom:review'],
  ] as const)(
    'changes only the %s category when the other list is omitted',
    async (category, flag, value) => {
      const result = await runCli([
        'config',
        'agents',
        flag,
        value,
        '--output-format',
        'json',
        '--no-input',
      ]);

      expect(result.exitCode).toBe(0);
      expect(mocks.setEnabledAgentKeys).toHaveBeenCalledWith(category, [
        value.split(',')[0],
        value.split(',')[1],
      ]);
      expect(mocks.setCustom).not.toHaveBeenCalled();
    },
  );

  it('sets both exact lists together when both flags are present', async () => {
    const result = await runCli([
      'config',
      'agents',
      '--workflow',
      'builtInWorkflow:write',
      '--tool-use',
      'builtInToolUse:assistant',
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(0);
    expect(mocks.setCustom).toHaveBeenCalledWith({
      workflowAgentKeys: ['builtInWorkflow:write'],
      toolUseAgentKeys: ['builtInToolUse:assistant'],
    });
    expect(mocks.setEnabledAgentKeys).not.toHaveBeenCalled();
  });

  it('reports an unknown team id as a usage error', async () => {
    mocks.setTeam.mockRejectedValueOnce(
      new InvalidAgentTeamError('Unknown agent team: missing-team'),
    );

    const result = await runCli([
      'config',
      'agents',
      '--team',
      'missing-team',
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(2);
    expect(mocks.setTeam).toHaveBeenCalledWith('missing-team');
  });

  it('reports an invalid default team id as a usage error', async () => {
    mocks.setDefaultTeam.mockRejectedValueOnce(
      new InvalidAgentTeamError(
        'Only a built-in team can be the user default: custom-team',
      ),
    );

    const result = await runCli([
      'config',
      'agents',
      '--default-team',
      'custom-team',
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(2);
    expect(mocks.setDefaultTeam).toHaveBeenCalledWith('custom-team');
  });

  it('canonicalizes a default chat agent from the effective roster', async () => {
    const result = await runCli([
      'config',
      'agents',
      '--default-agent',
      'assistant',
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(0);
    expect(mocks.setWorkspaceCliChatAgent).toHaveBeenCalledWith(
      process.cwd(),
      'builtInToolUse:assistant',
    );
  });

  it('rejects a default chat agent outside the effective roster', async () => {
    const result = await runCli([
      'config',
      'agents',
      '--default-agent',
      'review',
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(2);
    expect(mocks.setWorkspaceCliChatAgent).not.toHaveBeenCalled();
  });
});
