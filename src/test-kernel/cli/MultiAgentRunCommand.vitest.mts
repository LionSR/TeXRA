import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '@cli/runtime/cliContext';

const mocks = vi.hoisted(() => {
  const stdinInputFile = Object.assign(vi.fn(), { cleanup: vi.fn() });
  return {
    executeCliRequest: vi.fn(),
    expandRunInputs: vi.fn(),
    cliMultiAgentPlanHasGaps: vi.fn(),
    cliMultiAgentPresetTeamLaunchBlockReason: vi.fn(),
    getToolUseAgents: vi.fn(),
    getWorkflowAgents: vi.fn(),
    initCliPlatform: vi.fn(),
    installCliApprovalHandlers: vi.fn(),
    isAuthenticated: vi.fn(),
    loadAgents: vi.fn(),
    planCliMultiAgentPresets: vi.fn(),
    planCliMultiAgentPresetRun: vi.fn(),
    stdinInputFile,
    writeTextStderr: vi.fn(),
    writeTextStdout: vi.fn(),
  };
});

vi.mock('@agent/index', () => ({
  getToolUseAgents: mocks.getToolUseAgents,
  getWorkflowAgents: mocks.getWorkflowAgents,
  loadAgents: mocks.loadAgents,
}));

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: vi.fn(),
}));

vi.mock('@cli/runtime/approvalAdapter', () => ({
  hasCliApprovalDenied: vi.fn(() => false),
  installCliApprovalHandlers: mocks.installCliApprovalHandlers,
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
  const delegationTools = new Set([
    'delegate_workflow',
    'delegate_agent',
    'resume_agent',
    'propose_workflow',
    'propose_agent',
  ]);

  return {
    agentHasDelegationTools: vi.fn(
      (agent: { tools?: readonly string[] }) =>
        agent.tools?.some((tool) => delegationTools.has(tool)) ?? false,
    ),
    cliMultiAgentPlanHasGaps: mocks.cliMultiAgentPlanHasGaps,
    cliMultiAgentPresetTeamLaunchBlockReason:
      mocks.cliMultiAgentPresetTeamLaunchBlockReason,
    cliMultiAgentPresetNdjsonRecords: vi.fn(() => []),
    findCliMultiAgentPreset: vi.fn(() => ({
      id: 'mathematician',
      name: 'Mathematician',
      description: 'For math papers.',
      workflowAgents: [],
      toolUseAgents: ['orchestrator'],
      source: 'built-in',
    })),
    formatCliMultiAgentPresetDetails: vi.fn(() => ''),
    formatCliMultiAgentPresetInspection: vi.fn(() => ''),
    formatCliMultiAgentPresetList: vi.fn(() => ''),
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

vi.mock('@cli/commands/_helpers/modelArg', () => ({
  buildHeadlessRunContext: vi.fn((context: CliContext, model: string) => ({
    ...context,
    helperModel: model,
    quietLogs: true,
    renderRunProgress: false,
  })),
  resolveCliRunModel: vi.fn(
    async (_context: CliContext, model: string | undefined) =>
      model ?? 'deepseekT',
  ),
}));

vi.mock('@cli/commands/_helpers/runExecution', () => ({
  executeCliRequest: mocks.executeCliRequest,
}));

vi.mock('@cli/commands/_helpers/workflowInputs', () => ({
  createStdinWorkflowInputMaterializer: vi.fn(() => mocks.stdinInputFile),
  expandRunInputs: mocks.expandRunInputs,
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

describe('CLI multi-agent run command', () => {
  const approvalUnavailableWarning =
    'WARN preset mathematician may run without subagent delegation because approval policy "never" denies approval-gated delegation tools. Use an interactive run to answer prompts, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.';
  const headlessAskWarning =
    'WARN preset mathematician may run without subagent delegation because headless approval policy "ask" cannot show delegation prompts. Use an interactive run to answer prompts, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expandRunInputs.mockResolvedValue({
      inputFiles: ['problem.tex'],
      contextFiles: [],
    });
    mocks.getWorkflowAgents.mockReturnValue([]);
    mocks.cliMultiAgentPlanHasGaps.mockReturnValue(false);
    mocks.cliMultiAgentPresetTeamLaunchBlockReason.mockReturnValue(undefined);
    mocks.planCliMultiAgentPresets.mockImplementation((presets) =>
      presets.map((preset: unknown) =>
        mocks.planCliMultiAgentPresetRun(preset, {
          workflowAgents: mocks.getWorkflowAgents(),
          toolUseAgents: mocks.getToolUseAgents(),
        }),
      ),
    );
    mocks.getToolUseAgents.mockReturnValue([
      {
        name: 'orchestrator',
        category: 'toolUse',
        source: 'builtInToolUse',
        path: '/agents/orchestrator.yaml',
        tools: ['delegate_agent'],
      },
    ]);
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
    mocks.executeCliRequest.mockResolvedValue({
      result: {
        category: 'toolUse',
        executionId: 'exec-1',
        status: 'completed',
        lastResponse: 'The proof is correct.',
      },
      terminalStatus: 'completed',
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
    expect(mocks.executeCliRequest).toHaveBeenCalledTimes(1);
    expect(mocks.executeCliRequest.mock.calls[0]?.[2]).toMatchObject({
      enforceCategory: true,
      registerExecution: true,
      markErrorOnThrow: true,
      stopAfterCycle: true,
    });
    expect(mocks.expandRunInputs).toHaveBeenCalledWith(
      ['problem.tex'],
      [],
      '/tmp/project',
      {
        allowEmptyInput: true,
        stdinInputFile: mocks.stdinInputFile,
      },
    );
    const request = mocks.executeCliRequest.mock.calls[0]?.[0];
    expect(request?.config.instruction).toContain('Primary user input files:');
    expect(request?.config.instruction).toContain('- "problem.tex"');
    expect(mocks.stdinInputFile.cleanup).toHaveBeenCalledTimes(1);
  });

  it('marks run-plan resolution when authenticated gaps triggered a remote load', async () => {
    const { loadCliMultiAgentRunPlan } =
      await import('@cli/commands/multiAgent');
    mocks.cliMultiAgentPlanHasGaps.mockReturnValueOnce(true);
    mocks.isAuthenticated.mockResolvedValueOnce(true);

    const result = await loadCliMultiAgentRunPlan({
      preset: 'mathematician',
    });

    expect(result.remoteAgentLoadAttempted).toBe(true);
    expect(result.plan.rootAgent?.name).toBe('orchestrator');
    expect(mocks.loadAgents).toHaveBeenCalledWith();
    expect(mocks.planCliMultiAgentPresetRun).toHaveBeenCalledTimes(2);
  });

  it('does not mark run-plan resolution when unauthenticated gaps stay local-only', async () => {
    const { loadCliMultiAgentRunPlan } =
      await import('@cli/commands/multiAgent');
    mocks.cliMultiAgentPlanHasGaps.mockReturnValueOnce(true);
    mocks.isAuthenticated.mockResolvedValueOnce(false);

    const result = await loadCliMultiAgentRunPlan({
      preset: 'mathematician',
    });

    expect(result.remoteAgentLoadAttempted).toBe(false);
    expect(mocks.loadAgents).not.toHaveBeenCalled();
    expect(mocks.planCliMultiAgentPresetRun).toHaveBeenCalledTimes(1);
  });

  it('marks preset-list resolution when authenticated gaps triggered a remote load', async () => {
    const { loadCliMultiAgentPresetPlanSet } =
      await import('@cli/commands/multiAgent');
    mocks.cliMultiAgentPlanHasGaps.mockReturnValueOnce(true);
    mocks.isAuthenticated.mockResolvedValueOnce(true);

    const result = await loadCliMultiAgentPresetPlanSet([
      {
        id: 'mathematician',
        name: 'Mathematician',
        description: 'For math papers.',
        icon: 'codicon-symbol-operator',
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

  it('warns when headless ask cannot show delegation prompts', async () => {
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

    expect(exitCode).toBe(0);
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(headlessAskWarning);
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
    mocks.expandRunInputs.mockResolvedValue({
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
    expect(mocks.expandRunInputs).toHaveBeenCalledWith([], [], '/tmp/project', {
      allowEmptyInput: true,
      stdinInputFile: mocks.stdinInputFile,
    });
    const request = mocks.executeCliRequest.mock.calls[0]?.[0];
    expect(request?.config.inputFiles).toEqual([]);
    expect(request?.config.instruction).toContain('User instruction:');
    expect(request?.config.instruction).toContain(
      'Prove that every odd square is congruent to 1 modulo 8.',
    );
    expect(mocks.stdinInputFile.cleanup).toHaveBeenCalledTimes(1);
  });

  it('allows instruction-file-only team runs without input files', async () => {
    mocks.expandRunInputs.mockResolvedValue({
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
      expect(mocks.expandRunInputs).toHaveBeenCalledWith([], [], root, {
        allowEmptyInput: true,
        stdinInputFile: mocks.stdinInputFile,
      });
      const request = mocks.executeCliRequest.mock.calls[0]?.[0];
      expect(request?.config.inputFiles).toEqual([]);
      expect(request?.config.instruction).toContain('User instruction:');
      expect(request?.config.instruction).toContain(
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
    expect(mocks.expandRunInputs).not.toHaveBeenCalled();
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
    expect(mocks.expandRunInputs).not.toHaveBeenCalled();
  });

  it('refuses signed-out preset fallback to one root agent', async () => {
    mocks.cliMultiAgentPresetTeamLaunchBlockReason.mockReturnValueOnce(
      'root lean cannot delegate',
    );
    mocks.planCliMultiAgentPresetRun.mockReturnValue({
      preset: {
        id: 'mathematician',
        name: 'Mathematician',
        source: 'built-in',
      },
      rootAgent: {
        name: 'lean',
        category: 'toolUse',
        source: 'builtInToolUse',
        path: '/agents/lean.yaml',
        tools: [],
      },
      missingWorkflowAgents: ['generic', 'devise', 'apply'],
      missingToolUseAgents: ['simplifier', 'progressCheck', 'orchestrator'],
      workflowAgentKeys: [],
      toolUseAgentKeys: ['builtInToolUse:lean'],
    });
    const { runMultiAgentPreset } = await import('@cli/commands/multiAgent');

    const exitCode = await runMultiAgentPreset(cliContext(), {
      preset: 'mathematician',
      inputFiles: [],
      contextFiles: [],
      model: 'deepseekT',
      instruction: 'Solve a short math problem.',
    });

    expect(exitCode).toBe(2);
    expect(mocks.executeCliRequest).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Multi-agent preset "mathematician" cannot start as a team: root lean cannot delegate. Run `texra multi-agent inspect mathematician` to see missing agents. Start a single-agent chat with `texra chat --agent lean` if that is what you want.',
    );
    expect(mocks.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('WARN team delegation unavailable'),
    );
  });

  it('keeps degraded-team wording when the root can delegate', async () => {
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
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'WARN preset mathematician is degraded; running root agent orchestrator with 1 available team agent.',
    );
  });

  it('refuses a delegating root with no available team members', async () => {
    mocks.cliMultiAgentPresetTeamLaunchBlockReason.mockReturnValueOnce(
      'no available team members',
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
      missingWorkflowAgents: ['generic'],
      missingToolUseAgents: ['simplifier'],
      workflowAgentKeys: [],
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

    expect(exitCode).toBe(2);
    expect(mocks.executeCliRequest).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Multi-agent preset "mathematician" cannot start as a team: no available team members. Run `texra multi-agent inspect mathematician` to see missing agents. Start a single-agent chat with `texra chat --agent orchestrator` if that is what you want.',
    );
    expect(mocks.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('Enable a delegating team root'),
    );
  });
});
