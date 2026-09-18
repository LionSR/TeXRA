import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidAgentTeamError } from '@agent/index';
import { effectRuntime } from '@platform/processRuntime';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';

const mocks = vi.hoisted(() => ({
  clearDefaultTeam: vi.fn(),
  getVisibleAgents: vi.fn(),
  initLocalCliPlatform: vi.fn(),
  readCliAgentRoster: vi.fn(),
  // Every roster mutation is a composed Effect now, so the doubles answer with
  // one: a bare `vi.fn()` returns undefined, which `runPromise` cannot run.
  setAll: vi.fn(() => Effect.void),
  setCustom: vi.fn(() => Effect.void),
  // The roster refuses an unknown team in its own right, so these two are
  // typed for the refusal the tests below fail them with.
  setDefaultTeam: vi.fn<() => Effect.Effect<void, InvalidAgentTeamError>>(
    () => Effect.void,
  ),
  setEnabledAgentKeys: vi.fn(() => Effect.void),
  setInherited: vi.fn(() => Effect.void),
  setTeam: vi.fn<() => Effect.Effect<void, InvalidAgentTeamError>>(
    () => Effect.void,
  ),
  setWorkspaceCliChatAgent: vi.fn(() => Effect.void),
}));

vi.mock('@cli/runtime/initPlatform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/initPlatform')>()),
  initLocalCliPlatform: mocks.initLocalCliPlatform,
}));

vi.mock('@agent/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/index')>()),
  createWorkspaceAgentRosterController: () => ({
    clearDefaultTeam: mocks.clearDefaultTeam,
    getVisibleAgents: mocks.getVisibleAgents,
    setAll: mocks.setAll,
    setCustom: mocks.setCustom,
    setDefaultTeam: mocks.setDefaultTeam,
    setEnabledAgentKeys: mocks.setEnabledAgentKeys,
    setInherited: mocks.setInherited,
    setTeam: mocks.setTeam,
  }),
}));

vi.mock('@cli/runtime/agentRoster', () => ({
  formatCliAgentRoster: () => 'Agent roster',
  readCliAgentRoster: () => Effect.promise(() => mocks.readCliAgentRoster()),
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
    // The roster controller and the roster read are mocked above, so the
    // roots only have to be present.
    mocks.initLocalCliPlatform.mockResolvedValue({
      runtime: effectRuntime(),
      roots: {},
    });
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
    ['workflow', '--workflow', ['builtInWorkflow:write', 'custom:review']],
    ['toolUse', '--tool-use', ['builtInToolUse:assistant', 'custom:review']],
  ] as const)(
    'changes only the %s category when the other list is omitted',
    async (category, flag, keys) => {
      const result = await runCli([
        'config',
        'agents',
        flag,
        keys.join(','),
        '--output-format',
        'json',
        '--no-input',
      ]);

      expect(result.exitCode).toBe(0);
      expect(mocks.setEnabledAgentKeys).toHaveBeenCalledWith(category, keys);
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
      workflow: ['builtInWorkflow:write'],
      toolUse: ['builtInToolUse:assistant'],
    });
    expect(mocks.setEnabledAgentKeys).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'team',
      flag: '--team',
      value: 'missing-team',
      mock: () => mocks.setTeam,
      message: 'Unknown agent team: missing-team',
    },
    {
      name: 'default team',
      flag: '--default-team',
      value: 'custom-team',
      mock: () => mocks.setDefaultTeam,
      message: 'Only a built-in team can be the user default: custom-team',
    },
  ])(
    'reports an invalid $name id as a usage error',
    async ({ flag, value, mock, message }) => {
      mock().mockReturnValueOnce(
        Effect.fail(new InvalidAgentTeamError(message)),
      );

      const result = await runCli([
        'config',
        'agents',
        flag,
        value,
        '--output-format',
        'json',
        '--no-input',
      ]);

      expect(result.exitCode).toBe(2);
      expect(mock()).toHaveBeenCalledWith(value);
    },
  );

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
