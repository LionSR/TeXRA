import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '@cli/runtime/cliContext';

const mocks = vi.hoisted(() => ({
  executeCliToolUseConfig: vi.fn(),
  withExpandedRunInputs: vi.fn(),
  cliMultiAgentPlanHasGaps: vi.fn(),
  cliMultiAgentPresetCanLaunchTeam: vi.fn(),
  formatCliMultiAgentPresetRunWarnings: vi.fn(),
  formatCliMultiAgentTeamLaunchBlockMessage: vi.fn(),
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getVisibleAgents: vi.fn(),
  initCliPlatform: vi.fn(),
  isAuthenticated: vi.fn(),
  loadAgents: vi.fn(),
  planCliMultiAgentPresets: vi.fn(),
  planCliMultiAgentPresetRun: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTextStdout: vi.fn(),
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
  getAgentsByCategory: mocks.getAgentsByCategory,
  getVisibleAgents: mocks.getVisibleAgents,
  loadAgents: mocks.loadAgents,
}));

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: vi.fn(),
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

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => ({
    isAuthenticated: mocks.isAuthenticated,
  }),
}));

vi.mock('@cli/runtime/multiAgentPresets', () => {
  return {
    cliMultiAgentPlanHasGaps: mocks.cliMultiAgentPlanHasGaps,
    cliMultiAgentPresetCanLaunchTeam: mocks.cliMultiAgentPresetCanLaunchTeam,
    cliMultiAgentPresetNdjsonRecords: vi.fn(() => []),
    findCliMultiAgentPreset: vi.fn(() => ({
      id: 'mathematician',
      name: 'Mathematician',
      description: 'For math papers.',
      workflowAgents: [],
      toolUseAgents: ['orchestrator'],
      source: 'built-in',
    })),
    formatCliMultiAgentPresetInspection: vi.fn(() => ''),
    formatCliMultiAgentPresetList: vi.fn(() => ''),
    formatCliMultiAgentPresetRunWarnings:
      mocks.formatCliMultiAgentPresetRunWarnings,
    formatCliMultiAgentTeamLaunchBlockMessage:
      mocks.formatCliMultiAgentTeamLaunchBlockMessage,
    MULTI_AGENT_TEAM_ROOT_AGENT_DESCRIPTION:
      'Root agent for the team run (defaults to the preset orchestrator)',
    MULTI_AGENT_TEAM_ROOT_MODEL_DESCRIPTION: 'Model for the team root agent',
    planCliMultiAgentPresets: mocks.planCliMultiAgentPresets,
    planCliMultiAgentPresetRun: mocks.planCliMultiAgentPresetRun,
    readCliMultiAgentPresets: vi.fn(() => []),
    withCliMultiAgentPresetVisibility: vi.fn(
      (_plan: unknown, run: () => Promise<unknown>) => run(),
    ),
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

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp/project',
    mode: 'headless',
    outputFormat: 'text',
    approvalPolicy: 'never',
    quietLogs: false,
    renderRunProgress: true,
    stderrIsTty: false,
    stdoutColorEnabled: false,
    stderrColorEnabled: false,
    colorEnabled: false,
    version: '0.0.0',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
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
    mocks.cliMultiAgentPlanHasGaps.mockReturnValue(false);
    mocks.cliMultiAgentPresetCanLaunchTeam.mockReturnValue(true);
    mocks.formatCliMultiAgentTeamLaunchBlockMessage.mockReturnValue(
      'blocked preset message',
    );
    mocks.formatCliMultiAgentPresetRunWarnings.mockReturnValue([]);
    mocks.planCliMultiAgentPresets.mockImplementation((presets) =>
      presets.map((preset: unknown) =>
        mocks.planCliMultiAgentPresetRun(preset, {
          workflowAgents: mocks.getAgentsByCategory('workflow'),
          toolUseAgents: mocks.getAgentsByCategory('toolUse'),
        }),
      ),
    );
    mocks.getAgentsByCategory.mockImplementation((category: string) =>
      category === 'toolUse'
        ? [
            {
              name: 'orchestrator',
              category: 'toolUse',
              source: 'builtInToolUse',
              path: '/agents/orchestrator.yaml',
              tools: ['delegate_agent'],
            },
          ]
        : [],
    );
    mocks.planCliMultiAgentPresetRun.mockReturnValue({
      preset: {
        id: 'mathematician',
        name: 'Mathematician',
        source: 'built-in',
      },
      rootAgent: {
        name: 'orchestrator',
        category: 'toolUse',
        source: 'builtInToolUse',
        path: '/agents/orchestrator.yaml',
        tools: ['delegate_agent'],
      },
      missingWorkflowAgents: [],
      missingToolUseAgents: [],
      workflowAgentKeys: [],
      toolUseAgentKeys: ['builtInToolUse:orchestrator'],
    });
    mocks.isAuthenticated.mockResolvedValue(false);
    mocks.executeCliToolUseConfig.mockResolvedValue({
      ok: true,
      displayResult: { lastResponse: 'The proof is correct.' },
      exitCode: 0,
    });
  });

  it('stops the headless team root after one cycle instead of waiting for a follow-up', async () => {
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(cliContext(), {
      preset: 'mathematician',
      inputFiles: ['problem.tex'],
      contextFiles: [],
      model: 'deepseekT',
      instruction: 'Inspect the proof without editing files.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.executeCliToolUseConfig).toHaveBeenCalledTimes(1);
    expect(mocks.executeCliToolUseConfig.mock.calls[0]?.[2]).toMatchObject({
      enforceCategory: true,
      registerExecution: true,
      markErrorOnThrow: true,
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
    expect(config?.instruction).toContain('Primary user input files:');
    expect(config?.instruction).toContain('- "problem.tex"');
    expect(config?.instruction).toContain(
      'This CLI run exits after your final response.',
    );
    expect(config?.instruction).toContain(
      'Do not end by asking the user whether to perform more work',
    );
  });

  it('marks run-plan resolution when authenticated gaps triggered a remote load', async () => {
    const { loadCliMultiAgentRunPlan } =
      await import('@cli/runtime/multiAgentRunPlan');
    mocks.cliMultiAgentPlanHasGaps.mockReturnValueOnce(true);
    mocks.isAuthenticated.mockResolvedValueOnce(true);

    const result = await loadCliMultiAgentRunPlan({
      preset: 'mathematician',
    });

    expect(result.remoteAgentLoadAttempted).toBe(true);
    expect(result.plan.rootAgent?.name).toBe('orchestrator');
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    // The second call is the remote-inclusive reload: `loadAgents()`.
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(2);
    expect(mocks.planCliMultiAgentPresetRun).toHaveBeenCalledTimes(2);
  });

  it('does not mark run-plan resolution when unauthenticated gaps stay local-only', async () => {
    const { loadCliMultiAgentRunPlan } =
      await import('@cli/runtime/multiAgentRunPlan');
    mocks.cliMultiAgentPlanHasGaps.mockReturnValueOnce(true);
    mocks.isAuthenticated.mockResolvedValueOnce(false);

    const result = await loadCliMultiAgentRunPlan({
      preset: 'mathematician',
    });

    expect(result.remoteAgentLoadAttempted).toBe(false);
    expect(mocks.loadAgents).toHaveBeenCalledOnce();
    expect(mocks.loadAgents).toHaveBeenCalledWith({ includeRemote: false });
    expect(mocks.planCliMultiAgentPresetRun).toHaveBeenCalledTimes(1);
  });

  it('marks preset-list resolution when authenticated gaps triggered a remote load', async () => {
    const { loadCliMultiAgentPresetPlanSet } =
      await import('@cli/runtime/multiAgentRunPlan');
    mocks.cliMultiAgentPlanHasGaps.mockReturnValueOnce(true);
    mocks.isAuthenticated.mockResolvedValueOnce(true);

    const result = await loadCliMultiAgentPresetPlanSet([
      {
        id: 'mathematician',
        name: 'Mathematician',
        description: 'For math papers.',
        icon: 'symbol-operator',
        workflowAgents: [],
        toolUseAgents: ['orchestrator'],
        source: 'built-in',
      },
    ]);

    expect(result.remoteAgentLoadAttempted).toBe(true);
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    expect(mocks.loadAgents).toHaveBeenNthCalledWith(2);
    expect(mocks.planCliMultiAgentPresetRun).toHaveBeenCalledTimes(2);
  });

  it('reports resolved remote agent loads without implying final missing agents', async () => {
    const remoteLoadMessage =
      'Preset mathematician loaded remote agents before launch. Run `texra multi-agent show mathematician` to view the resolved team.';
    mocks.cliMultiAgentPlanHasGaps
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    mocks.isAuthenticated.mockResolvedValueOnce(true);
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(cliContext(), {
      preset: 'mathematician',
      inputFiles: ['problem.tex'],
      contextFiles: [],
      model: 'deepseekT',
      instruction: 'Solve the problem with the team.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(remoteLoadMessage);
    expect(mocks.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('not available locally'),
    );
  });

  it('warns when approval policy never blocks team delegation', async () => {
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(cliContext(), {
      preset: 'mathematician',
      inputFiles: ['problem.tex'],
      contextFiles: [],
      model: 'deepseekT',
      instruction: 'Solve the problem with the team.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      approvalUnavailableWarning,
    );
  });

  it('refuses headless ask before launching a team run', async () => {
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(
      cliContext({ approvalPolicy: 'ask' }),
      {
        preset: 'mathematician',
        inputFiles: ['problem.tex'],
        contextFiles: [],
        model: 'deepseekT',
        instruction: 'Solve the problem with the team.',
      },
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
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(
      cliContext({ approvalPolicy: 'yolo' }),
      {
        preset: 'mathematician',
        inputFiles: ['problem.tex'],
        contextFiles: [],
        model: 'deepseekT',
        instruction: 'Solve the problem with the team.',
      },
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
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(cliContext(), {
      preset: 'mathematician',
      inputFiles: [],
      contextFiles: [],
      model: 'deepseekT',
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
      const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

      const exitCode = await runMultiAgentPreset(cliContext({ cwd: root }), {
        preset: 'mathematician',
        inputFiles: [],
        contextFiles: [],
        model: 'deepseekT',
        instruction: 'Then summarize the plan.',
        instructionFile: 'prompt.txt',
      });

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
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    await expect(
      runMultiAgentPreset(cliContext(), {
        preset: 'mathematician',
        inputFiles: [],
        contextFiles: [],
        model: 'deepseekT',
        instruction: '',
        instructionFile: 'missing-prompt.txt',
      }),
    ).rejects.toThrow(
      /--instruction-file: file not found: missing-prompt\.txt/,
    );
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });

  it('still requires an input file or instruction text', async () => {
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    await expect(
      runMultiAgentPreset(cliContext(), {
        preset: 'mathematician',
        inputFiles: [],
        contextFiles: [],
        model: 'deepseekT',
        instruction: '',
      }),
    ).rejects.toThrow(
      /Provide --input, --instruction, or --instruction-file for the team task\. Example: texra multi-agent run physicist --instruction "Check this derivation"/,
    );
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });

  it('refuses built-in presets without a runnable root agent', async () => {
    const plan = {
      preset: {
        id: 'mathematician',
        name: 'Mathematician',
        source: 'built-in',
      },
      rootAgent: undefined,
      missingWorkflowAgents: ['generic', 'devise', 'apply'],
      missingToolUseAgents: ['simplifier', 'progressCheck', 'orchestrator'],
      workflowAgentKeys: [],
      toolUseAgentKeys: ['builtInToolUse:lean'],
    };
    const message =
      'Multi-agent preset "mathematician" cannot start as a team: no runnable team root. Run `texra multi-agent show mathematician` to see missing agents. Install or sign in for a runnable team root before launching this preset.';
    mocks.cliMultiAgentPresetCanLaunchTeam.mockReturnValueOnce(false);
    mocks.formatCliMultiAgentTeamLaunchBlockMessage.mockReturnValueOnce(
      message,
    );
    mocks.planCliMultiAgentPresetRun.mockReturnValue(plan);
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(cliContext(), {
      preset: 'mathematician',
      inputFiles: [],
      contextFiles: [],
      model: 'deepseekT',
      instruction: 'Solve a short math problem.',
    });

    expect(exitCode).toBe(2);
    expect(mocks.executeCliToolUseConfig).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(message);
    expect(
      mocks.formatCliMultiAgentTeamLaunchBlockMessage,
    ).toHaveBeenCalledWith(plan, {
      requestedPreset: 'mathematician',
      followUpAdvice:
        'Install or sign in for a runnable team root before launching this preset.',
    });
    expect(mocks.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('WARN team delegation unavailable'),
    );
  });

  it('keeps degraded-team wording when the root can delegate', async () => {
    const warning =
      'WARN preset mathematician is degraded; running root agent orchestrator with 1 available team agent.';
    mocks.formatCliMultiAgentPresetRunWarnings.mockReturnValueOnce([warning]);
    mocks.planCliMultiAgentPresetRun.mockReturnValue({
      preset: {
        id: 'mathematician',
        name: 'Mathematician',
        source: 'built-in',
      },
      rootAgent: {
        name: 'orchestrator',
        category: 'toolUse',
        source: 'builtInToolUse',
        path: '/agents/orchestrator.yaml',
        tools: ['delegate_agent'],
      },
      missingWorkflowAgents: ['generic'],
      missingToolUseAgents: ['simplifier'],
      workflowAgentKeys: ['builtIn:devise'],
      toolUseAgentKeys: ['builtInToolUse:orchestrator'],
    });
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(cliContext(), {
      preset: 'mathematician',
      inputFiles: [],
      contextFiles: [],
      model: 'deepseekT',
      instruction: 'Solve a short math problem.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(warning);
  });

  it('refuses a delegating root with no available team members', async () => {
    const plan = {
      preset: {
        id: 'mathematician',
        name: 'Mathematician',
        source: 'built-in',
      },
      rootAgent: {
        name: 'orchestrator',
        category: 'toolUse',
        source: 'builtInToolUse',
        path: '/agents/orchestrator.yaml',
        tools: ['delegate_agent'],
      },
      missingWorkflowAgents: ['generic'],
      missingToolUseAgents: ['simplifier'],
      workflowAgentKeys: [],
      toolUseAgentKeys: ['builtInToolUse:orchestrator'],
    };
    const message =
      'Multi-agent preset "mathematician" cannot start as a team: no available team members. Run `texra multi-agent show mathematician` to see missing agents. Start a single-agent chat with `texra chat --agent orchestrator` if that is what you want.';
    mocks.cliMultiAgentPresetCanLaunchTeam.mockReturnValueOnce(false);
    mocks.formatCliMultiAgentTeamLaunchBlockMessage.mockReturnValueOnce(
      message,
    );
    mocks.planCliMultiAgentPresetRun.mockReturnValue(plan);
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(cliContext(), {
      preset: 'mathematician',
      inputFiles: [],
      contextFiles: [],
      model: 'deepseekT',
      instruction: 'Solve a short math problem.',
    });

    expect(exitCode).toBe(2);
    expect(mocks.executeCliToolUseConfig).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(message);
    expect(
      mocks.formatCliMultiAgentTeamLaunchBlockMessage,
    ).toHaveBeenCalledWith(plan, {
      requestedPreset: 'mathematician',
      followUpAdvice:
        'Start a single-agent chat with `texra chat --agent orchestrator` if that is what you want.',
    });
    expect(mocks.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('Enable a delegating team root'),
    );
  });
});
