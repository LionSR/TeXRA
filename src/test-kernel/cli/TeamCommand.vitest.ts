/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */

import { it } from '@effect/vitest';
import { beforeEach, describe, expect, vi } from 'vitest';

// Shared mock registrations must evaluate before anything that loads
// the mocked modules — keep these imports immediately after the vitest
// import.
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { cliLogSinksMock } from '@test/support/cliLogSinksMock';
import { cliOutputMock } from '@test/support/cliOutputMock';

import { Effect } from 'effect';
import { ensureError } from '@utils/errors/errorMessage';

import type { CliContext } from '@cli/runtime/cliContext';
import { RUN_OUTCOME } from '@shared/schemas';
import { createRunCommandCliContext } from '@test/cli/fixtures/cliContext';
import {
  fakeProcessServices,
  type FakeProcessServices,
  installedHost,
} from '@test/support/setupPlatform';
import { testRuntime } from '@test/support/testProcessRuntime';

const mocks = vi.hoisted(() => ({
  executeCliToolUseConfig: vi.fn(),
  withExpandedRunInputs: vi.fn(),
  canLaunchTeam: vi.fn(),
  findTeamPreset: vi.fn(() => ({
    id: 'mathematician',
    name: 'Mathematician',
    description: 'For math papers.',
    agents: ['orchestrator'],
    source: 'built-in',
  })),
  formatCliTeamRunWarnings: vi.fn(),
  formatCliTeamLaunchBlockMessage: vi.fn(),
  planTeamRuns: vi.fn(),
  planTeamRun: vi.fn(),
}));

vi.mock('@cli/runtime/cliTeams', () => ({
  cliTeamNdjsonRecords: vi.fn(() => []),
  formatCliTeamInspection: vi.fn(() => ''),
  formatCliTeamList: vi.fn(() => ''),
  formatCliTeamRunWarnings: mocks.formatCliTeamRunWarnings,
  formatCliTeamLaunchBlockMessage: mocks.formatCliTeamLaunchBlockMessage,
  readCliTeams: vi.fn(() => Effect.succeed([])),
}));

vi.mock('@common/teams/TeamPlan', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@common/teams/TeamPlan')>();
  return {
    ...actual,
    canLaunchTeam: mocks.canLaunchTeam,
    planTeamRun: mocks.planTeamRun,
    planTeamRuns: mocks.planTeamRuns,
  };
});

vi.mock('@common/teams/TeamPresets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@common/teams/TeamPresets')>()),
  findTeamPreset: mocks.findTeamPreset,
}));

vi.mock('@cli/runtime/runModel', () => ({
  buildHeadlessRunContext: vi.fn((context: CliContext) => ({
    ...context,
    quietLogs: true,
    renderRunProgress: false,
  })),
  selectCliRunModel: vi.fn((_context: CliContext, model: string | undefined) =>
    Effect.succeed(model ?? 'deepseek/deepseek-v4-flash'),
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

const { runTeam: nativeRun } = await import('@cli/commands/team');

type TeamRunInit = Parameters<typeof nativeRun>[1];

const ORCHESTRATOR_AGENT = {
  name: 'orchestrator',
  source: 'builtIn',
  blocks: {},
  path: '/agents/orchestrator.yaml',
  tools: ['agent'],
};

interface TeamPlan {
  readonly preset: { id: string; name: string; source: string };
  readonly rootAgent?: typeof ORCHESTRATOR_AGENT;
  readonly missingAgents: string[];
  readonly agentKeys: string[];
}

function teamPlan(overrides: Partial<TeamPlan> = {}): TeamPlan {
  return {
    preset: {
      id: 'mathematician',
      name: 'Mathematician',
      source: 'built-in',
    },
    rootAgent: ORCHESTRATOR_AGENT,
    missingAgents: [],
    agentKeys: ['builtIn:orchestrator'],
    ...overrides,
  };
}

const preset = (
  init: Partial<TeamRunInit> & Pick<TeamRunInit, 'instruction'>,
  context: CliContext = createRunCommandCliContext(),
) =>
  Effect.provide(
    nativeRun(context, {
      team: 'mathematician',
      inputFiles: [],
      contextFiles: [],
      model: 'deepseek/deepseek-v4-flash',
      ...init,
    }),
    fakeProcessServices(),
  );

function runPreset(
  init: Partial<TeamRunInit> & Pick<TeamRunInit, 'instruction'>,
  context?: CliContext,
): Promise<number> {
  return Effect.runPromise(preset(init, context));
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

describe('CLI team run command', () => {
  const headlessAskError =
    'Cannot run team "mathematician" with headless approval policy "ask": approval prompts cannot be answered. Use an interactive run to answer prompts, pass --approval-policy never to deny approval-gated tools, or pass --approval-policy yolo only when you intentionally want to auto-approve privileged tools.';

  beforeEach(() => {
    vi.clearAllMocks();
    // The CLI init hands its caller the platform's stores; the commands
    // under test read `secrets`/`globalState` off what it returns.
    const services = {
      ...installedHost().platform,
      config: installedHost().roots.config,
      runtime: testRuntime(),
    };
    cliInitPlatformMock.initCliPlatform.mockReturnValue(
      Effect.succeed(services),
    );
    mockExpandedRunInputs({
      inputFiles: ['problem.tex'],
      contextFiles: [],
    });
    mocks.canLaunchTeam.mockReturnValue(true);
    mocks.formatCliTeamLaunchBlockMessage.mockReturnValue(
      'blocked preset message',
    );
    mocks.formatCliTeamRunWarnings.mockReturnValue([]);
    mocks.planTeamRuns.mockImplementation((presets, options) =>
      presets.map((preset: unknown) => mocks.planTeamRun(preset, options)),
    );
    mocks.planTeamRun.mockReturnValue(teamPlan());
    mocks.executeCliToolUseConfig.mockResolvedValue({
      ok: true,
      result: {
        runId: 'exec-team',
        outcome: RUN_OUTCOME.COMPLETED,
        output: {
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
      kind: 'team-result',
      ...emission.json,
    });
    expect(emission?.text).toBe('The proof is correct.');
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
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
    expect(mocks.executeCliToolUseConfig).not.toHaveBeenCalled();
  });
});
