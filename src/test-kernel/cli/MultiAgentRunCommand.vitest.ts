/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared mock registrations must evaluate before anything that loads
// the mocked modules — keep these imports immediately after the vitest
// import (enforced by architecture/supportMockImportOrder.vitest.ts).
import { agentCatalogMock } from '@test/support/agentCatalogMock';
import '@test/support/agentStorageFinalizationMock';
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { cliLogSinksMock } from '@test/support/cliLogSinksMock';
import { cliOutputMock } from '@test/support/cliOutputMock';

import { Effect } from 'effect';
import { ensureError } from '@utils/errors/errorMessage';

import { SupabaseClient } from '@auth/SupabaseClient';
import type { CliContext } from '@cli/runtime/cliContext';
import { RUN_OUTCOME } from '@shared/schemas';
import { createRunCommandCliContext } from '@test/cli/fixtures/cliContext';
import {
  fakeProcessServices,
  type FakeProcessServices,
  installedHost,
} from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const mocks = vi.hoisted(() => ({
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
  planTeamRuns: vi.fn(),
  planTeamRun: vi.fn(),
}));

vi.mock('@cli/runtime/multiAgentPresets', () => ({
  cliMultiAgentPresetNdjsonRecords: vi.fn(() => []),
  formatCliMultiAgentPresetInspection: vi.fn(() => ''),
  formatCliMultiAgentPresetList: vi.fn(() => ''),
  formatCliMultiAgentPresetRunWarnings:
    mocks.formatCliMultiAgentPresetRunWarnings,
  formatCliMultiAgentTeamLaunchBlockMessage:
    mocks.formatCliMultiAgentTeamLaunchBlockMessage,
  readCliMultiAgentPresets: vi.fn(() => []),
}));

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

vi.mock('@cli/runtime/executeCli', () => ({
  executeCliToolUseConfig: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.executeCliToolUseConfig(...args),
      catch: ensureError,
    }),
}));

vi.mock('@cli/runtime/workflowInputs', () => ({
  withExpandedRunInputs: (
    ...args: Parameters<
      typeof import('@cli/runtime/workflowInputs').withExpandedRunInputs<
        unknown,
        unknown,
        FakeProcessServices
      >
    >
  ) =>
    Effect.tryPromise({
      try: () =>
        mocks.withExpandedRunInputs(
          ...args.slice(0, 4),
          (inputs: Parameters<(typeof args)[4]>[0]) =>
            Effect.runPromise(
              Effect.provide(args[4](inputs), fakeProcessServices()),
            ),
        ),
      catch: ensureError,
    }),
}));

const isAuthenticatedSpy = vi.spyOn(SupabaseClient, 'isAuthenticated');

const { runMultiAgentPreset: nativeRun } =
  await import('@cli/commands/multiAgent');
const runMultiAgentPreset = (...args: Parameters<typeof nativeRun>) =>
  Effect.runPromise(Effect.provide(nativeRun(...args), fakeProcessServices()));
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

function runPreset(
  init: Partial<MultiAgentRunInit> & Pick<MultiAgentRunInit, 'instruction'>,
  context: CliContext = createRunCommandCliContext(),
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
  expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledWith(options.message);
  expect(mocks.formatCliMultiAgentTeamLaunchBlockMessage).toHaveBeenCalledWith(
    options.plan,
    {
      requestedPreset: 'mathematician',
      followUpAdvice: options.followUpAdvice,
    },
  );
  expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalledWith(
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

function mockMaterializedStdin(inputFiles: string[]): void {
  mocks.withExpandedRunInputs.mockImplementationOnce(
    async (
      _inputSpecs: readonly string[],
      _contextSpecs: readonly string[],
      _cwd: string,
      _options: unknown,
      run: (expanded: {
        readonly inputFiles: string[];
        readonly contextFiles: string[];
        readonly stdinInputPath?: string;
      }) => Promise<unknown>,
    ) => run({ inputFiles, contextFiles: [], stdinInputPath: inputFiles[0] }),
  );
}

describe('CLI multi-agent run command', () => {
  const tempDirs = useTempDirs();
  const approvalUnavailableWarning =
    'WARN preset mathematician may run without subagent delegation because approval policy "never" denies approval-gated delegation tools. Use an interactive run to answer prompts, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.';
  const headlessAskError =
    'Cannot run multi-agent preset "mathematician" with headless approval policy "ask": delegation prompts cannot be answered. Use an interactive run to answer prompts, pass --approval-policy never to deny approval-gated tools, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.';

  beforeEach(() => {
    vi.clearAllMocks();
    // The CLI init hands its caller the platform's stores; the commands
    // under test read `secrets`/`globalState` off what it returns.
    const { platform } = installedHost();
    cliInitPlatformMock.initLocalCliPlatform.mockResolvedValue(platform);
    cliInitPlatformMock.initCliPlatform.mockResolvedValue(platform);
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
            workflow: agentCatalogMock.getAgentsByCategory('workflow'),
            toolUse: agentCatalogMock.getAgentsByCategory('toolUse'),
          },
        }),
      ),
    );
    agentCatalogMock.getAgentsByCategory.mockImplementation(
      (category: string) =>
        category === 'toolUse' ? [ORCHESTRATOR_AGENT] : [],
    );
    mocks.planTeamRun.mockReturnValue(teamPlan());
    isAuthenticatedSpy.mockResolvedValue(false);
    mocks.executeCliToolUseConfig.mockResolvedValue({
      ok: true,
      result: {
        runId: 'exec-team',
        outcome: RUN_OUTCOME.COMPLETED,
        output: {
          category: 'toolUse',
          response: 'The proof is correct.',
          files: [],
        },
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
    const emission = cliOutputMock.emitCliResult.mock.calls[0]?.[1];
    // The emitted result is the run's result: its id is `runId`.
    expect(emission?.json.result).toEqual({
      runId: 'exec-team',
      outcome: RUN_OUTCOME.COMPLETED,
      output: {
        category: 'toolUse',
        response: 'The proof is correct.',
        files: [],
      },
      workingDirectory: '/tmp/project',
    });
    // `outcome` is the only terminal fact the headless JSON publishes, and what
    // the run produced rides `output`.
    expect(Object.keys(emission?.json.result ?? {})).toEqual([
      'runId',
      'outcome',
      'output',
      'workingDirectory',
    ]);
    expect(emission?.ndjson).toEqual({
      kind: 'multi-agent-result',
      ...emission.json,
    });
    expect(emission?.text).toBe('The proof is correct.');
  });

  it('marks materialized stdin as unavailable for team recovery advertising', async () => {
    mockMaterializedStdin(['.texra-tmp/stdin.tex']);

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
    isAuthenticatedSpy.mockResolvedValueOnce(true);

    const result = await loadCliMultiAgentRunPlan({
      preset: 'mathematician',
    });

    expect(result.remoteCatalogRefreshAttempted).toBe(true);
    expect(result.plan.rootAgent?.name).toBe('orchestrator');
    expect(agentCatalogMock.loadAgents).toHaveBeenNthCalledWith(1, {
      includeRemote: false,
    });
    // The remote-inclusive reload goes through `refresh()`, not a second
    // `loadAgents()`.
    expect(agentCatalogMock.refresh).toHaveBeenCalledWith({
      includeRemote: true,
    });
    expect(mocks.planTeamRun).toHaveBeenCalledTimes(2);
  });

  it('reports resolved remote agent loads without implying final missing agents', async () => {
    const remoteLoadMessage =
      'Preset mathematician loaded remote agents before launch. Run `texra multi-agent show mathematician` to view the resolved team.';
    mocks.teamPlanHasGaps.mockReturnValueOnce(true).mockReturnValueOnce(false);
    isAuthenticatedSpy.mockResolvedValueOnce(true);

    const exitCode = await runPreset({
      inputFiles: ['problem.tex'],
      instruction: 'Solve the problem with the team.',
    });

    expect(exitCode).toBe(0);
    expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledWith(
      remoteLoadMessage,
    );
    expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('not available locally'),
    );
  });

  it('warns when approval policy never blocks team delegation', async () => {
    const exitCode = await runPreset({
      inputFiles: ['problem.tex'],
      instruction: 'Solve the problem with the team.',
    });

    expect(exitCode).toBe(0);
    expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledWith(
      approvalUnavailableWarning,
    );
  });

  it('refuses headless ask before launching a team run', async () => {
    const exitCode = await runPreset(
      {
        inputFiles: ['problem.tex'],
        instruction: 'Solve the problem with the team.',
      },
      createRunCommandCliContext({ approvalPolicy: 'ask' }),
    );

    expect(exitCode).toBe(2);
    expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledWith(
      headlessAskError,
    );
    expect(cliInitPlatformMock.initCliPlatform).toHaveBeenCalledOnce();
    expect(agentCatalogMock.loadAgents).toHaveBeenCalledOnce();
    expect(agentCatalogMock.loadAgents).toHaveBeenCalledWith({
      includeRemote: false,
    });
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
    expect(mocks.executeCliToolUseConfig).not.toHaveBeenCalled();
  });

  it('does not warn when yolo can auto-approve delegation', async () => {
    const exitCode = await runPreset(
      {
        inputFiles: ['problem.tex'],
        instruction: 'Solve the problem with the team.',
      },
      createRunCommandCliContext({ approvalPolicy: 'yolo' }),
    );

    expect(exitCode).toBe(0);
    expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalledWith(
      expect.stringContaining('may run without subagent delegation'),
    );
  });

  it('shows attached inputs instead of orchestration guidance without an instruction', async () => {
    mockExpandedRunInputs({
      inputFiles: ['problem.tex'],
      contextFiles: ['reference.tex'],
    });
    const exitCode = await runPreset({
      inputFiles: [' problem.tex '],
      contextFiles: [' reference.tex '],
      instruction: '',
    });

    expect(exitCode).toBe(0);
    const config = mocks.executeCliToolUseConfig.mock.calls[0]?.[0];
    expect(config?.displayInstruction).toContain('Attached input files:');
    expect(config?.displayInstruction).toContain('- "problem.tex"');
    expect(config?.displayInstruction).toContain(
      '\n\nAttached read-only context files:\n- "reference.tex"',
    );
    expect(config?.displayInstruction).not.toContain(
      'Run the "Mathematician" multi-agent team preset.',
    );
    expect(config?.displayInstruction).not.toContain(
      'Read and use them before delegating work.',
    );
    expect(config?.instruction).toContain(
      'Run the "Mathematician" multi-agent team preset.',
    );
  });

  it('uses a stable display label for a file-only stdin launch', async () => {
    mockMaterializedStdin(['.texra-tmp/texra-stdin-123/stdin.tex']);

    const exitCode = await runPreset({ inputFiles: [' - '], instruction: '' });

    expect(exitCode).toBe(0);
    const config = mocks.executeCliToolUseConfig.mock.calls[0]?.[0];
    expect(config?.displayInstruction).toBe(
      'Attached input files:\n- Standard input',
    );
    expect(config?.displayInstruction).not.toContain('texra-stdin-123');
    expect(config?.inputFiles).toEqual([
      '.texra-tmp/texra-stdin-123/stdin.tex',
    ]);
  });

  it('allows instruction-file-only team runs without input files', async () => {
    mockExpandedRunInputs({
      inputFiles: [],
      contextFiles: [],
    });
    const root = await makeTempDir('texra-agent-team-', tempDirs);
    await fs.writeFile(
      path.join(root, 'prompt.txt'),
      'Read the prompt from disk.\n',
    );

    const exitCode = await runPreset(
      {
        instruction: 'Then summarize the plan.',
        instructionFile: 'prompt.txt',
      },
      createRunCommandCliContext({ cwd: root }),
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
