import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { CliContext } from '@cli/runtime/cliContext';

const mocks = vi.hoisted(() => {
  const stdinInputFile = Object.assign(vi.fn(), { cleanup: vi.fn() });
  return {
    executeCliRequest: vi.fn(),
    expandRunInputs: vi.fn(),
    installCliApprovalHandlers: vi.fn(),
    loadAgents: vi.fn(),
    resolveAgentWithRemoteFallback: vi.fn(),
    stdinInputFile,
  };
});

vi.mock('@agent/index', () => ({
  loadAgents: mocks.loadAgents,
}));

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: vi.fn(),
}));

vi.mock('@cli/runtime/approvalAdapter', () => ({
  installCliApprovalHandlers: mocks.installCliApprovalHandlers,
}));

vi.mock('@cli/commands/_helpers/modelArg', () => ({
  buildHeadlessRunContext: vi.fn((context: CliContext, model: string) => ({
    ...context,
    helperModel: model,
    quietLogs: true,
    renderRunProgress: false,
  })),
  resolveCliRunModel: vi.fn(
    async (_context: CliContext, model: string | undefined) => model ?? 'gpt54',
  ),
}));

vi.mock('@cli/commands/_helpers/output', () => ({
  emitCliResult: vi.fn(),
}));

vi.mock('@cli/commands/_helpers/remoteAgents', () => ({
  resolveAgentWithRemoteFallback: mocks.resolveAgentWithRemoteFallback,
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

describe('CLI agents run command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expandRunInputs.mockResolvedValue({
      inputFiles: ['problem.md'],
      contextFiles: ['notes.md'],
    });
    mocks.resolveAgentWithRemoteFallback.mockResolvedValue({
      name: 'chat',
      category: AgentCategory.ToolUse,
      source: 'builtInToolUse',
      path: '/agents/chat.yaml',
      tools: ['read_file'],
    });
    mocks.executeCliRequest.mockResolvedValue({
      result: {
        category: AgentCategory.ToolUse,
        executionId: 'exec-1',
        status: 'completed',
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
    expect(mocks.expandRunInputs).toHaveBeenCalledWith(
      ['problem.md'],
      ['notes.md'],
      '/tmp/project',
      {
        allowEmptyInput: true,
        requireWorkspaceFiles: true,
        stdinInputFile: mocks.stdinInputFile,
      },
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
});
