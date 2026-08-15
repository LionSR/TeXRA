import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { RUN_OUTCOME, AgentCategory } from '@shared/schemas';
import { createRunCommandCliContext } from '@test/cli/fixtures/cliContext';
import '@test/support/agentCatalogMock';
import '@test/support/agentStorageFinalizationMock';
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { cliLogSinksMock } from '@test/support/cliLogSinksMock';
import { cliOutputMock } from '@test/support/cliOutputMock';

const mocks = vi.hoisted(() => ({
  executeCliToolUseConfig: vi.fn(),
  withExpandedRunInputs: vi.fn(),
  resolveCliLaunchAgent: vi.fn(),
  selectCliRunModel: vi.fn(),
}));

vi.mock('@cli/runtime/runModel', () => ({
  buildHeadlessRunContext: vi.fn((context: CliContext) => ({
    ...context,
    quietLogs: true,
    renderRunProgress: false,
  })),
  selectCliRunModel: mocks.selectCliRunModel,
}));

vi.mock('@cli/runtime/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/agents')>()),
  resolveCliLaunchAgent: mocks.resolveCliLaunchAgent,
}));

vi.mock('@cli/runtime/runExecution', () => ({
  executeCliToolUseConfig: mocks.executeCliToolUseConfig,
}));

vi.mock('@cli/runtime/workflowInputs', () => ({
  withExpandedRunInputs: mocks.withExpandedRunInputs,
}));

// Hoisted out of each test body — a dynamic import()'s result is cached, so
// one call here serves every test below.
const { runToolUseAgent } = await import('@cli/commands/agentsRun');

describe('CLI agents run command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withExpandedRunInputs.mockImplementation(
      async (
        _inputSpecs: readonly string[],
        _contextSpecs: readonly string[],
        _cwd: string,
        _options: unknown,
        run: (inputs: {
          readonly inputFiles: string[];
          readonly contextFiles: string[];
        }) => Promise<unknown>,
      ) => run({ inputFiles: ['problem.md'], contextFiles: ['notes.md'] }),
    );
    mocks.resolveCliLaunchAgent.mockResolvedValue({
      name: 'chat',
      category: AgentCategory.ToolUse,
      source: 'builtInToolUse',
      path: '/agents/chat.yaml',
      tools: ['read_file'],
    });
    mocks.selectCliRunModel.mockImplementation(
      async (_context: CliContext, model: string | undefined) =>
        model ?? 'gpt54',
    );
    mocks.executeCliToolUseConfig.mockResolvedValue({
      ok: true,
      result: {
        category: AgentCategory.ToolUse,
        executionId: 'exec-1',
        streamId: 'stream-1',
        outcome: RUN_OUTCOME.COMPLETED,
        response: 'Correct.',
        workingDirectory: '/tmp/project',
      },
      exitCode: 0,
    });
  });

  it('anchors headless tool-use runs on provided files without polluting display text', async () => {
    const exitCode = await runToolUseAgent(createRunCommandCliContext(), {
      agent: 'chat',
      inputFiles: ['problem.md'],
      contextFiles: ['notes.md'],
      model: 'gpt54',
      instruction: 'Assess the proof concisely.',
    });

    expect(exitCode).toBe(0);
    expect(cliInitPlatformMock.initLocalCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
    expect(
      cliInitPlatformMock.initLocalCliPlatform.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.resolveCliLaunchAgent.mock.invocationCallOrder[0]);
    expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith(
      'chat',
      'agentsRun',
    );
    expect(mocks.withExpandedRunInputs).toHaveBeenCalledWith(
      ['problem.md'],
      ['notes.md'],
      '/tmp/project',
      {
        allowEmptyInput: true,
        requireWorkspaceFiles: true,
        readStdinText: expect.any(Function),
      },
      expect.any(Function),
    );
    const config = mocks.executeCliToolUseConfig.mock.calls[0]?.[0];
    expect(config?.inputFiles).toEqual(['problem.md']);
    expect(config?.contextFiles).toEqual(['notes.md']);
    expect(config?.displayInstruction).toBe('Assess the proof concisely.');
    expect(mocks.executeCliToolUseConfig.mock.calls[0]?.[2]).toMatchObject({
      recoveryInputIsDurable: true,
    });
    expect(config?.instruction).toContain('Primary user input files:');
    expect(config?.instruction).toContain('- "problem.md"');
    expect(config?.instruction).toContain('Read-only context files:');
    expect(config?.instruction).toContain('- "notes.md"');
    expect(config?.instruction).toContain('Additional user instruction:');
    expect(config?.instruction).toContain('Assess the proof concisely.');
    const emission = cliOutputMock.emitCliResult.mock.calls[0]?.[1];
    expect(emission?.json).toEqual({
      category: AgentCategory.ToolUse,
      executionId: 'exec-1',
      streamId: 'stream-1',
      outcome: RUN_OUTCOME.COMPLETED,
      response: 'Correct.',
      workingDirectory: '/tmp/project',
    });
    // `outcome` is the only terminal fact the headless JSON publishes.
    expect(Object.keys(emission?.json ?? {})).toEqual([
      'category',
      'executionId',
      'streamId',
      'outcome',
      'response',
      'workingDirectory',
    ]);
    expect(emission?.ndjson).toEqual({
      kind: 'agent-result',
      result: emission.json,
    });
    expect(emission?.text).toBe('Correct.');
  });

  it('marks materialized stdin as unavailable for recovery advertising', async () => {
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
    await runToolUseAgent(createRunCommandCliContext(), {
      agent: 'chat',
      inputFiles: ['-'],
      contextFiles: [],
      model: 'gpt54',
      instruction: 'Assess the proof.',
    });

    expect(mocks.executeCliToolUseConfig.mock.calls[0]?.[2]).toMatchObject({
      recoveryInputIsDurable: false,
    });
  });

  it('publishes the canonical outcome for a shutdown cancellation', async () => {
    mocks.executeCliToolUseConfig.mockResolvedValueOnce({
      ok: true,
      result: {
        category: AgentCategory.ToolUse,
        executionId: 'exec-interrupted',
        streamId: 'stream-interrupted',
        outcome: RUN_OUTCOME.CANCELLED,
        workingDirectory: '/tmp/project',
      },
      exitCode: CliExitCode.Interrupted,
    });
    const exitCode = await runToolUseAgent(createRunCommandCliContext(), {
      agent: 'chat',
      inputFiles: ['problem.md'],
      contextFiles: [],
      instruction: 'Assess the proof.',
    });

    expect(exitCode).toBe(CliExitCode.Interrupted);
    expect(cliOutputMock.emitCliResult.mock.calls[0]?.[1].json).toMatchObject({
      outcome: RUN_OUTCOME.CANCELLED,
    });
  });

  it('reports missing instruction before resolving the model', async () => {
    await expect(
      runToolUseAgent(createRunCommandCliContext(), {
        agent: 'chat',
        inputFiles: [],
        contextFiles: [],
        model: 'gpt54',
        instruction: '',
      }),
    ).rejects.toThrow('Provide --instruction or --instruction-file.');

    expect(cliInitPlatformMock.initLocalCliPlatform).not.toHaveBeenCalled();
    expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
    expect(mocks.resolveCliLaunchAgent).not.toHaveBeenCalled();
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });

  it.each([
    {
      scenario: 'missing agents',
      agent: 'missing-agent',
      message:
        'Tool-use agent not found: missing-agent. Use `texra agents list` for visible starter agents, `texra agents list --all` for the full catalog, or pass a known launchable agent name from a team preset.',
    },
    {
      scenario: 'workflow agents',
      agent: 'polish',
      message:
        'Agent "polish" is a workflow agent; `texra agents run` only handles tool-use agents. Use `texra run polish` for workflow agents.',
    },
  ])(
    'reports $scenario before resolving the model',
    async ({ agent, message }) => {
      mocks.resolveCliLaunchAgent.mockRejectedValueOnce(new Error(message));
      await expect(
        runToolUseAgent(createRunCommandCliContext(), {
          agent,
          inputFiles: [],
          contextFiles: [],
          model: 'gpt54',
          instruction: 'Check this.',
        }),
      ).rejects.toThrow(message);

      expect(cliInitPlatformMock.initLocalCliPlatform).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/tmp/project' }),
      );
      expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith(
        agent,
        'agentsRun',
      );
      expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
      expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
    },
  );
});
