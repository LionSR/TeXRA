import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { CliContext } from '@cli/runtime/cliContext';
import { RUN_OUTCOME } from '@shared/schemas';

const mocks = vi.hoisted(() => {
  return {
    executeCliRequest: vi.fn(),
    withExpandedRunInputs: vi.fn(),
    initLocalCliPlatform: vi.fn(),
    isAuthenticated: vi.fn(),
    resolveCliLaunchAgent: vi.fn(),
    resolveCliRunModel: vi.fn(),
    writeErrorStderr: vi.fn(),
    writeTextStderr: vi.fn(),
  };
});

vi.mock('@agent/index', () => ({
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getVisibleAgents: vi.fn(),
  loadAgents: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initLocalCliPlatform: mocks.initLocalCliPlatform,
}));

vi.mock('@cli/runtime/supabaseAuth', () => ({
  getCliAuthProvider: () => ({
    isAuthenticated: mocks.isAuthenticated,
  }),
}));

vi.mock('@cli/runtime/runModel', () => ({
  buildHeadlessRunContext: vi.fn((context: CliContext, model: string) => ({
    ...context,
    helperModel: model,
    quietLogs: true,
    renderRunProgress: false,
  })),
  resolveCliRunModel: mocks.resolveCliRunModel,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeErrorStderr: mocks.writeErrorStderr,
  writeTextStderr: mocks.writeTextStderr,
}));

vi.mock('@cli/commands/_helpers/output', () => ({
  emitCliResult: vi.fn(),
}));

vi.mock('@cli/runtime/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/agents')>()),
  resolveCliLaunchAgent: mocks.resolveCliLaunchAgent,
}));

vi.mock('@cli/runtime/runExecution', () => ({
  executeCliRequest: mocks.executeCliRequest,
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
    mocks.resolveCliRunModel.mockImplementation(
      async (_context: CliContext, model: string | undefined) =>
        model ?? 'gpt54',
    );
    mocks.executeCliRequest.mockResolvedValue({
      result: {
        category: AgentCategory.ToolUse,
        executionId: 'exec-1',
        outcome: RUN_OUTCOME.COMPLETED,
        lastResponse: 'Correct.',
      },
      terminalStatus: 'completed',
    });
  });

  it('anchors headless tool-use runs on provided files without polluting display text', async () => {
    const { runToolUseAgent } = await import('@cli/commands/agentsRun');

    const exitCode = await runToolUseAgent(cliContext(), {
      agent: 'chat',
      inputFiles: ['problem.md'],
      contextFiles: ['notes.md'],
      model: 'gpt54',
      instruction: 'Assess the proof concisely.',
    });

    expect(exitCode).toBe(0);
    expect(mocks.initLocalCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
    expect(mocks.initLocalCliPlatform.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveCliLaunchAgent.mock.invocationCallOrder[0],
    );
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
    const request = mocks.executeCliRequest.mock.calls[0]?.[0];
    expect(request?.config.inputFiles).toEqual(['problem.md']);
    expect(request?.config.contextFiles).toEqual(['notes.md']);
    expect(request?.config.displayInstruction).toBe(
      'Assess the proof concisely.',
    );
    expect(request?.config.instruction).toContain('Primary user input files:');
    expect(request?.config.instruction).toContain('- "problem.md"');
    expect(request?.config.instruction).toContain('Read-only context files:');
    expect(request?.config.instruction).toContain('- "notes.md"');
    expect(request?.config.instruction).toContain(
      'Additional user instruction:',
    );
    expect(request?.config.instruction).toContain(
      'Assess the proof concisely.',
    );
  });

  it('reports missing instruction before resolving the model', async () => {
    const { runToolUseAgent } = await import('@cli/commands/agentsRun');

    await expect(
      runToolUseAgent(cliContext(), {
        agent: 'chat',
        inputFiles: [],
        contextFiles: [],
        model: 'gpt54',
        instruction: '',
      }),
    ).rejects.toThrow('Provide --instruction or --instruction-file.');

    expect(mocks.initLocalCliPlatform).not.toHaveBeenCalled();
    expect(mocks.resolveCliRunModel).not.toHaveBeenCalled();
    expect(mocks.resolveCliLaunchAgent).not.toHaveBeenCalled();
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });

  it('reports missing agents before resolving the model', async () => {
    mocks.resolveCliLaunchAgent.mockRejectedValueOnce(
      new Error(
        'Tool-use agent not found: missing-agent. Use `texra agents list` for visible starter agents, or pass a known launchable agent name from a team preset.',
      ),
    );
    const { runToolUseAgent } = await import('@cli/commands/agentsRun');

    await expect(
      runToolUseAgent(cliContext(), {
        agent: 'missing-agent',
        inputFiles: [],
        contextFiles: [],
        model: 'gpt54',
        instruction: 'Check this.',
      }),
    ).rejects.toThrow(
      'Tool-use agent not found: missing-agent. Use `texra agents list` for visible starter agents, or pass a known launchable agent name from a team preset.',
    );

    expect(mocks.initLocalCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
    expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith(
      'missing-agent',
      'agentsRun',
    );
    expect(mocks.resolveCliRunModel).not.toHaveBeenCalled();
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });

  it('reports workflow agents before resolving the model', async () => {
    mocks.resolveCliLaunchAgent.mockRejectedValueOnce(
      new Error(
        'Agent "polish" is a workflow agent; `texra agents run` only handles tool-use agents. Use `texra run polish` for workflow agents.',
      ),
    );
    const { runToolUseAgent } = await import('@cli/commands/agentsRun');

    await expect(
      runToolUseAgent(cliContext(), {
        agent: 'polish',
        inputFiles: [],
        contextFiles: [],
        model: 'gpt54',
        instruction: 'Check this.',
      }),
    ).rejects.toThrow(
      'Agent "polish" is a workflow agent; `texra agents run` only handles tool-use agents. Use `texra run polish` for workflow agents.',
    );

    expect(mocks.initLocalCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
    expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith(
      'polish',
      'agentsRun',
    );
    expect(mocks.resolveCliRunModel).not.toHaveBeenCalled();
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });
});
