import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SupabaseClient } from '@auth/SupabaseClient';
import type { CliContext } from '@cli/runtime/cliContext';
import { RUN_OUTCOME } from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const mocks = vi.hoisted(() => ({
  emitCliResult: vi.fn(),
  executeCliToolUseConfig: vi.fn(),
  withExpandedRunInputs: vi.fn(),
  teamPlanHasGaps: vi.fn(),
  canLaunchTeam: vi.fn(),
  findTeamPreset: vi.fn(() => ({
    id: 'mathematician',
    name: 'Mathematician',
    description: 'For math papers.',
    agents: {
      workflow: [],
      toolUse: ['orchestrator'],
    },
    source: 'built-in',
  })),
  formatCliMultiAgentPresetRunWarnings: vi.fn(),
  formatCliMultiAgentTeamLaunchBlockMessage: vi.fn(),
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getVisibleAgents: vi.fn(),
  initCliPlatform: vi.fn(),
  loadAgents: vi.fn(),
  refreshAgents: vi.fn(),
  planTeamRuns: vi.fn(),
  planTeamRun: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTextStdout: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
  getAgentsByCategory: mocks.getAgentsByCategory,
  getVisibleAgents: mocks.getVisibleAgents,
  loadAgents: mocks.loadAgents,
  refresh: mocks.refreshAgents,
}));

vi.mock('@agent/storage', () => ({
  finalizeExecution: vi.fn().mockResolvedValue({
    status: 'durable',
    terminalStatusPersisted: true,
    flowRecord: 'deleted',
  }),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
  initLocalCliPlatform: vi.fn(),
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeNdjsonStdout: vi.fn(),
  writeTextStderr: mocks.writeTextStderr,
  writeTextStdout: mocks.writeTextStdout,
}));

vi.mock('@cli/commands/_helpers/output', () => ({
  emitCliResult: mocks.emitCliResult,
}));

vi.mock('@cli/runtime/multiAgentPresets', () => {
  return {
    cliMultiAgentPresetNdjsonRecords: vi.fn(() => []),
    formatCliMultiAgentPresetInspection: vi.fn(() => ''),
    formatCliMultiAgentPresetList: vi.fn(() => ''),
    formatCliMultiAgentPresetRunWarnings:
      mocks.formatCliMultiAgentPresetRunWarnings,
    formatCliMultiAgentTeamLaunchBlockMessage:
      mocks.formatCliMultiAgentTeamLaunchBlockMessage,
    MULTI_AGENT_TEAM_ROOT_AGENT_DESCRIPTION:
      'Root agent for the team run (defaults to the preset orchestrator)',
    MULTI_AGENT_TEAM_ROOT_MODEL_DESCRIPTION: 'Model for the team root agent',
    readCliMultiAgentPresets: vi.fn(() => []),
  };
});

vi.mock('@common/teams/TeamPlan', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@common/teams/TeamPlan')>();
  return {
    ...actual,
    canLaunchTeam: mocks.canLaunchTeam,
    findTeamPreset: mocks.findTeamPreset,
    planTeamRun: mocks.planTeamRun,
    planTeamRuns: mocks.planTeamRuns,
    teamPlanHasGaps: mocks.teamPlanHasGaps,
  };
});

vi.mock('@cli/runtime/runModel', () => ({
  buildHeadlessRunContext: vi.fn((context: CliContext) => ({
    ...context,
    quietLogs: true,
    renderRunProgress: false,
  })),
  selectCliRunModel: vi.fn(
    async (_context: CliContext, model: string | undefined) =>
      model ?? 'deepseekT',
  ),
}));

vi.mock('@cli/runtime/runExecution', () => ({
  executeCliToolUseConfig: mocks.executeCliToolUseConfig,
}));

vi.mock('@cli/runtime/workflowInputs', () => ({
  withExpandedRunInputs: mocks.withExpandedRunInputs,
}));

const isAuthenticatedSpy = vi.spyOn(SupabaseClient, 'isAuthenticated');
const canAccessRemoteAgentCatalogSpy = vi.spyOn(
  SupabaseClient,
  'canAccessRemoteAgentCatalog',
);

const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');
const { loadCliMultiAgentPresetPlanSet, loadCliMultiAgentRunPlan } =
  await import('@cli/runtime/multiAgentRunPlan');

type MultiAgentRunInit = Parameters<typeof runMultiAgentPreset>[1];

const ORCHESTRATOR_AGENT = {
  name: 'orchestrator',
  category: 'toolUse',
  source: 'builtInToolUse',
  path: '/agents/orchestrator.yaml',
  tools: ['delegate_agent'],
};

interface TeamPlan {
  readonly preset: { id: string; name: string; source: string };
  readonly rootAgent?: typeof ORCHESTRATOR_AGENT;
  readonly missingAgents: { workflow: string[]; toolUse: string[] };
  readonly agentKeys: { workflow: string[]; toolUse: string[] };
}

function teamPlan(overrides: Partial<TeamPlan> = {}): TeamPlan {
  return {
    preset: {
      id: 'mathematician',
      name: 'Mathematician',
      source: 'built-in',
    },
    rootAgent: ORCHESTRATOR_AGENT,
    missingAgents: {
      workflow: [],
      toolUse: [],
    },
    agentKeys: {
      workflow: [],
      toolUse: ['builtInToolUse:orchestrator'],
    },
    ...overrides,
  };
}

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    renderRunProgress: true,
    ...overrides,
  });
}

function runPreset(
  init: Partial<MultiAgentRunInit> & Pick<MultiAgentRunInit, 'instruction'>,
  context: CliContext = cliContext(),
): Promise<number> {
  return runMultiAgentPreset(context, {
    preset: 'mathematician',
    inputFiles: [],
    contextFiles: [],
    model: 'deepseekT',
    ...init,
  });
}

async function expectBlockedLaunch(options: {
  readonly plan: TeamPlan;
  readonly message: string;
  readonly followUpAdvice: string;
  readonly unexpectedWarning: string;
}): Promise<void> {
  mocks.canLaunchTeam.mockReturnValueOnce(false);
  mocks.formatCliMultiAgentTeamLaunchBlockMessage.mockReturnValueOnce(
    options.message,
  );
  mocks.planTeamRun.mockReturnValue(options.plan);

  const exitCode = await runPreset({
    instruction: 'Solve a short math problem.',
  });

  expect(exitCode).toBe(2);
  expect(mocks.executeCliToolUseConfig).not.toHaveBeenCalled();
  expect(mocks.writeTextStderr).toHaveBeenCalledWith(options.message);
  expect(mocks.formatCliMultiAgentTeamLaunchBlockMessage).toHaveBeenCalledWith(
    options.plan,
    {
      requestedPreset: 'mathematician',
      followUpAdvice: options.followUpAdvice,
    },
  );
  expect(mocks.writeTextStderr).not.toHaveBeenCalledWith(
    expect.stringContaining(options.unexpectedWarning),
  );
}

function mockExpandedRunInputs(inputs: {
  readonly inputFiles: string[];
  readonly contextFiles: string[];
}): void {
  mocks.withExpandedRunInputs.mockImplementation(
    async (
      _inputSpecs: readonly string[],
      _contextSpecs: readonly string[],
      _cwd: string,
      _options: unknown,
      run: (expanded: {
        readonly inputFiles: string[];
        readonly contextFiles: string[];
      }) => Promise<unknown>,
    ) => run(inputs),
  );
}

describe('CLI multi-agent run command', () => {
  const approvalUnavailableWarning =
    'WARN preset mathematician may run without subagent delegation because approval policy "never" denies approval-gated delegation tools. Use an interactive run to answer prompts, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.';
  const headlessAskError =
    'Cannot run multi-agent preset "mathematician" with headless approval policy "ask": delegation prompts cannot be answered. Use an interactive run to answer prompts, pass --approval-policy never to deny approval-gated tools, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExpandedRunInputs({
      inputFiles: ['problem.tex'],
      contextFiles: [],
    });
    mocks.teamPlanHasGaps.mockReturnValue(false);
    mocks.canLaunchTeam.mockReturnValue(true);
    mocks.formatCliMultiAgentTeamLaunchBlockMessage.mockReturnValue(
      'blocked preset message',
    );
    mocks.formatCliMultiAgentPresetRunWarnings.mockReturnValue([]);
    mocks.planTeamRuns.mockImplementation((presets) =>
      presets.map((preset: unknown) =>
        mocks.planTeamRun(preset, {
          agents: {
            workflow: mocks.getAgentsByCategory('workflow'),
            toolUse: mocks.getAgentsByCategory('toolUse'),
          },
        }),
      ),
    );
    mocks.getAgentsByCategory.mockImplementation((category: string) =>
      category === 'toolUse' ? [ORCHESTRATOR_AGENT] : [],
    );
    mocks.planTeamRun.mockReturnValue(teamPlan());
    isAuthenticatedSpy.mockResolvedValue(false);
    canAccessRemoteAgentCatalogSpy.mockResolvedValue(false);
    mocks.executeCliToolUseConfig.mockResolvedValue({
      ok: true,
      result: {
        category: 'toolUse',
        executionId: 'exec-team',
        streamId: 'stream-team',
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'The proof is correct.',
        workingDirectory: '/tmp/project',
      },
      exitCode: 0,
    });
  });

  it('stops the headless team root after one cycle instead of waiting for a follow-up', async () => {
    const exitCode = await runPreset({
      inputFiles: ['problem.tex'],
      instruction: 'Inspect the proof without editing files.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.executeCliToolUseConfig).toHaveBeenCalledTimes(1);
    expect(mocks.executeCliToolUseConfig.mock.calls[0]?.[2]).toMatchObject({
      enforceCategory: true,
      registerExecution: true,
      recoveryInputIsDurable: true,
      stopAfterCycle: true,
    });
    expect(mocks.withExpandedRunInputs).toHaveBeenCalledWith(
      ['problem.tex'],
      [],
      '/tmp/project',
      {
        allowEmptyInput: true,
        requireWorkspaceFiles: true,
        readStdinText: expect.any(Function),
      },
      expect.any(Function),
    );
    const config = mocks.executeCliToolUseConfig.mock.calls[0]?.[0];
    expect(config?.displayInstruction).toBe(
      'Inspect the proof without editing files.',
    );
    expect(config?.instruction).toContain('Primary user input files:');
    expect(config?.instruction).toContain('- "problem.tex"');
    expect(config?.instruction).toContain(
      'This CLI run exits after your final response.',
    );
    expect(config?.instruction).toContain(
      'Do not end by asking the user whether to perform more work',
    );
    const emission = mocks.emitCliResult.mock.calls[0]?.[1];
    expect(emission?.json.result).toEqual({
      category: 'toolUse',
      executionId: 'exec-team',
      streamId: 'stream-team',
      outcome: RUN_OUTCOME.COMPLETED,
      response: 'The proof is correct.',
      workingDirectory: '/tmp/project',
    });
    // `outcome` is the only terminal fact the headless JSON publishes.
    expect(Object.keys(emission?.json.result ?? {})).toEqual([
      'category',
      'executionId',
      'streamId',
      'outcome',
      'response',
      'workingDirectory',
    ]);
    expect(emission?.ndjson).toEqual({
      kind: 'multi-agent-result',
      ...emission.json,
    });
    expect(emission?.text).toBe('The proof is correct.');
  });

  it('marks materialized stdin as unavailable for team recovery advertising', async () => {
    mocks.withExpandedRunInputs.mockImplementationOnce(
      async (
        _inputSpecs: readonly string[],
        _contextSpecs: readonly string[],
        _cwd: string,
        _options: unknown,
        run: (inputs: {
          readonly inputFiles: string[];
          readonly contextFiles: string[];
          readonly hasMaterializedStdinInput: boolean;
        }) => Promise<unknown>,
      ) =>
        run({
          inputFiles: ['.texra-tmp/stdin.tex'],
          contextFiles: [],
          hasMaterializedStdinInput: true,
        }),
    );

    await runPreset({
      inputFiles: ['-'],
      instruction: 'Inspect the proof.',
    });

    expect(mocks.executeCliToolUseConfig.mock.calls[0]?.[2]).toMatchObject({
      recoveryInputIsDurable: false,
    });
  });

  it('marks run-plan resolution when authenticated gaps triggered a remote load', async () => {
    mocks.teamPlanHasGaps.mockReturnValueOnce(true);
    canAccessRemoteAgentCatalogSpy.mockResolvedValueOnce(true);

    const result = await loadCliMultiAgentRunPlan({
      preset: 'mathematician',
    });

    expect(result.remoteCatalogRefreshAttempted).toBe(true);
    expect(result.plan.rootAgent?.name).toBe('orchestrator');
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    // The remote-inclusive reload goes through `refresh()`, not a second
    // `loadAgents()`.
    expect(mocks.refreshAgents).toHaveBeenCalledWith({ includeRemote: true });
    expect(mocks.planTeamRun).toHaveBeenCalledTimes(2);
  });

  it('does not load remote agents for relay-token-only model authentication', async () => {
    mocks.teamPlanHasGaps.mockReturnValueOnce(true);
    isAuthenticatedSpy.mockResolvedValueOnce(true);
    canAccessRemoteAgentCatalogSpy.mockResolvedValueOnce(false);

    const result = await loadCliMultiAgentRunPlan({
      preset: 'mathematician',
    });

    expect(result.remoteCatalogRefreshAttempted).toBe(false);
    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(mocks.refreshAgents).not.toHaveBeenCalled();
    expect(isAuthenticatedSpy).not.toHaveBeenCalled();
    expect(mocks.planTeamRun).toHaveBeenCalledTimes(1);
  });

  it('marks preset-list resolution when authenticated gaps triggered a remote load', async () => {
    mocks.teamPlanHasGaps.mockReturnValueOnce(true);
    canAccessRemoteAgentCatalogSpy.mockResolvedValueOnce(true);

    const result = await loadCliMultiAgentPresetPlanSet([
      {
        id: 'mathematician',
        name: 'Mathematician',
        description: 'For math papers.',
        icon: 'cube',
        agents: {
          workflow: [],
          toolUse: ['orchestrator'],
        },
        source: 'built-in',
      },
    ]);

    expect(result.remoteCatalogRefreshAttempted).toBe(true);
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(mocks.refreshAgents).toHaveBeenCalledWith({ includeRemote: true });
    expect(mocks.planTeamRun).toHaveBeenCalledTimes(2);
  });

  it('reports resolved remote agent loads without implying final missing agents', async () => {
    const remoteLoadMessage =
      'Preset mathematician loaded remote agents before launch. Run `texra multi-agent show mathematician` to view the resolved team.';
    mocks.teamPlanHasGaps.mockReturnValueOnce(true).mockReturnValueOnce(false);
    canAccessRemoteAgentCatalogSpy.mockResolvedValueOnce(true);

    const exitCode = await runPreset({
      inputFiles: ['problem.tex'],
      instruction: 'Solve the problem with the team.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(remoteLoadMessage);
    expect(mocks.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('not available locally'),
    );
  });

  it('warns when approval policy never blocks team delegation', async () => {
    const exitCode = await runPreset({
      inputFiles: ['problem.tex'],
      instruction: 'Solve the problem with the team.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      approvalUnavailableWarning,
    );
  });

  it('refuses headless ask before launching a team run', async () => {
    const exitCode = await runPreset(
      {
        inputFiles: ['problem.tex'],
        instruction: 'Solve the problem with the team.',
      },
      cliContext({ approvalPolicy: 'ask' }),
    );

    expect(exitCode).toBe(2);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(headlessAskError);
    expect(mocks.initCliPlatform).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
    expect(mocks.executeCliToolUseConfig).not.toHaveBeenCalled();
  });

  it('does not warn when yolo can auto-approve delegation', async () => {
    const exitCode = await runPreset(
      {
        inputFiles: ['problem.tex'],
        instruction: 'Solve the problem with the team.',
      },
      cliContext({ approvalPolicy: 'yolo' }),
    );

    expect(exitCode).toBe(0);
    expect(mocks.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('may run without subagent delegation'),
    );
  });

  it('allows instruction-only team runs without input files', async () => {
    mockExpandedRunInputs({
      inputFiles: [],
      contextFiles: [],
    });

    const exitCode = await runPreset({
      instruction: 'Prove that every odd square is congruent to 1 modulo 8.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.withExpandedRunInputs).toHaveBeenCalledWith(
      [],
      [],
      '/tmp/project',
      {
        allowEmptyInput: true,
        requireWorkspaceFiles: true,
        readStdinText: expect.any(Function),
      },
      expect.any(Function),
    );
    const config = mocks.executeCliToolUseConfig.mock.calls[0]?.[0];
    expect(config?.inputFiles).toEqual([]);
    expect(config?.instruction).toContain('User instruction:');
    expect(config?.instruction).toContain(
      'Prove that every odd square is congruent to 1 modulo 8.',
    );
  });

  it('allows instruction-file-only team runs without input files', async () => {
    mockExpandedRunInputs({
      inputFiles: [],
      contextFiles: [],
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-agent-team-'));
    try {
      await fs.writeFile(
        path.join(root, 'prompt.txt'),
        'Read the prompt from disk.\n',
      );

      const exitCode = await runPreset(
        {
          instruction: 'Then summarize the plan.',
          instructionFile: 'prompt.txt',
        },
        cliContext({ cwd: root }),
      );

      expect(exitCode).toBe(0);
      expect(mocks.withExpandedRunInputs).toHaveBeenCalledWith(
        [],
        [],
        root,
        {
          allowEmptyInput: true,
          requireWorkspaceFiles: true,
          readStdinText: expect.any(Function),
        },
        expect.any(Function),
      );
      const config = mocks.executeCliToolUseConfig.mock.calls[0]?.[0];
      expect(config?.inputFiles).toEqual([]);
      expect(config?.instruction).toContain('User instruction:');
      expect(config?.instruction).toContain(
        'Read the prompt from disk.\n\nThen summarize the plan.',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing instruction files before expanding inputs', async () => {
    await expect(
      runPreset({
        instruction: '',
        instructionFile: 'missing-prompt.txt',
      }),
    ).rejects.toThrow(
      /--instruction-file: file not found: missing-prompt\.txt/,
    );
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });

  it('still requires an input file or instruction text', async () => {
    await expect(runPreset({ instruction: '' })).rejects.toThrow(
      /Provide --input, --instruction, or --instruction-file for the team task\. Example: texra multi-agent run physicist --instruction "Check this derivation"/,
    );
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });

  it('refuses built-in presets without a runnable root agent', async () => {
    await expectBlockedLaunch({
      plan: teamPlan({
        rootAgent: undefined,
        missingAgents: {
          workflow: ['generic', 'devise', 'apply'],
          toolUse: ['simplifier', 'progressCheck', 'orchestrator'],
        },
        agentKeys: { workflow: [], toolUse: ['builtInToolUse:lean'] },
      }),
      message:
        'Multi-agent preset "mathematician" cannot start as a team: no runnable team root. Run `texra multi-agent show mathematician` to see missing agents. Install or sign in for a runnable team root before launching this preset.',
      followUpAdvice:
        'Install or sign in for a runnable team root before launching this preset.',
      unexpectedWarning: 'WARN team delegation unavailable',
    });
  });

  it('keeps degraded-team wording when the root can delegate', async () => {
    const warning =
      'WARN preset mathematician is degraded; running root agent orchestrator with 1 available team agent.';
    mocks.formatCliMultiAgentPresetRunWarnings.mockReturnValueOnce([warning]);
    mocks.planTeamRun.mockReturnValue(
      teamPlan({
        missingAgents: {
          workflow: ['generic'],
          toolUse: ['simplifier'],
        },
        agentKeys: {
          workflow: ['builtIn:devise'],
          toolUse: ['builtInToolUse:orchestrator'],
        },
      }),
    );

    const exitCode = await runPreset({
      instruction: 'Solve a short math problem.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(warning);
  });

  it('refuses a delegating root with no available team members', async () => {
    await expectBlockedLaunch({
      plan: teamPlan({
        missingAgents: {
          workflow: ['generic'],
          toolUse: ['simplifier'],
        },
      }),
      message:
        'Multi-agent preset "mathematician" cannot start as a team: no available team members. Run `texra multi-agent show mathematician` to see missing agents. Start a single-agent chat with `texra chat --agent orchestrator` if that is what you want.',
      followUpAdvice:
        'Start a single-agent chat with `texra chat --agent orchestrator` if that is what you want.',
      unexpectedWarning: 'Enable a delegating team root',
    });
  });
});
