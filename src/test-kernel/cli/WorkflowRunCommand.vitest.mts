import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { CliContext } from '@cli/runtime/cliContext';
import { EXECUTION_STATUS, RUN_OUTCOME } from '@shared/schemas';

const mocks = vi.hoisted(() => {
  const stdinInputFile = Object.assign(vi.fn(), { cleanup: vi.fn() });
  return {
    executeCliRequest: vi.fn(),
    expandRunInputs: vi.fn(),
    initLocalCliPlatform: vi.fn(),
    resolveCliAgent: vi.fn(),
    resolveCliRunModel: vi.fn(),
    stdinInputFile,
  };
});

vi.mock('@agent/storage', () => ({
  writeTerminalStatus: vi.fn(),
}));

vi.mock('@utils/files', () => ({
  getRunDir: vi.fn((executionId: string) => `/tmp/runs/${executionId}`),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initLocalCliPlatform: mocks.initLocalCliPlatform,
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

vi.mock('@cli/commands/_helpers/output', () => ({
  emitCliResult: vi.fn(),
}));

vi.mock('@cli/runtime/agents', () => ({
  resolveCliAgent: mocks.resolveCliAgent,
}));

vi.mock('@cli/runtime/runExecution', () => ({
  executeCliRequest: mocks.executeCliRequest,
}));

vi.mock('@cli/runtime/workflowInputs', () => ({
  createStdinWorkflowInputMaterializer: vi.fn(() => mocks.stdinInputFile),
  expandRunInputs: mocks.expandRunInputs,
  hasMixedStdinWorkflowInputSpecs: vi.fn((inputFiles: readonly string[]) => {
    const specs = new Set(
      inputFiles.map((spec) => spec.trim()).filter(Boolean),
    );
    return specs.has('-') && specs.size > 1;
  }),
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

describe('CLI workflow run command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCliAgent.mockResolvedValue({
      name: 'polish',
      category: AgentCategory.Workflow,
      source: 'builtInWorkflow',
      path: '/agents/polish.yaml',
      tools: [],
    });
    mocks.resolveCliRunModel.mockImplementation(
      async (_context: CliContext, model: string | undefined) =>
        model ?? 'deepseekT',
    );
    mocks.expandRunInputs.mockResolvedValue({
      inputFiles: ['paper.tex'],
      contextFiles: [],
    });
    mocks.executeCliRequest.mockResolvedValue({
      result: {
        category: AgentCategory.Workflow,
        executionId: 'exec-1',
        streamId: 'stream-1',
        outcome: RUN_OUTCOME.COMPLETED,
        outputs: [],
        compileFailures: [],
      },
      terminalStatus: EXECUTION_STATUS.COMPLETED,
    });
  });

  it('reports conflicting output targets before platform or model lookup', async () => {
    const { runWorkflowAgent } = await import('@cli/commands/workflow');

    await expect(
      runWorkflowAgent(cliContext(), {
        agent: 'polish',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        output: 'out.tex',
        outputDir: 'out',
        instruction: '',
      }),
    ).rejects.toThrow('Use either --output or --output-dir, not both.');

    expect(mocks.initLocalCliPlatform).not.toHaveBeenCalled();
    expect(mocks.resolveCliAgent).not.toHaveBeenCalled();
    expect(mocks.resolveCliRunModel).not.toHaveBeenCalled();
    expect(mocks.expandRunInputs).not.toHaveBeenCalled();
  });

  it('reports missing workflow agents before resolving the model', async () => {
    mocks.resolveCliAgent.mockResolvedValueOnce(undefined);
    const { runWorkflowAgent } = await import('@cli/commands/workflow');

    await expect(
      runWorkflowAgent(cliContext(), {
        agent: 'missing-agent',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        instruction: '',
      }),
    ).rejects.toThrow(/Agent not found: missing-agent/);

    expect(mocks.initLocalCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
    expect(mocks.initLocalCliPlatform.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveCliAgent.mock.invocationCallOrder[0],
    );
    expect(mocks.resolveCliRunModel).not.toHaveBeenCalled();
    expect(mocks.expandRunInputs).not.toHaveBeenCalled();
  });

  it('reports tool-use agents before resolving the model', async () => {
    mocks.resolveCliAgent.mockResolvedValueOnce({
      name: 'chat',
      category: AgentCategory.ToolUse,
      source: 'builtInToolUse',
      path: '/agents/chat.yaml',
      tools: [],
    });
    const { runWorkflowAgent } = await import('@cli/commands/workflow');

    await expect(
      runWorkflowAgent(cliContext(), {
        agent: 'chat',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        instruction: '',
      }),
    ).rejects.toThrow(/`texra run` only handles workflow agents/);

    expect(mocks.initLocalCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
    expect(mocks.resolveCliRunModel).not.toHaveBeenCalled();
    expect(mocks.expandRunInputs).not.toHaveBeenCalled();
  });

  it('reports single-output mixed stdin usage before resolving the model', async () => {
    const { runWorkflowAgent } = await import('@cli/commands/workflow');

    await expect(
      runWorkflowAgent(cliContext(), {
        agent: 'polish',
        inputFiles: ['-', 'paper.tex'],
        contextFiles: [],
        output: 'out.tex',
        instruction: '',
      }),
    ).rejects.toThrow(
      'Use --output-dir for multi-input workflow runs; --output is only for a single final artifact.',
    );

    expect(mocks.initLocalCliPlatform).toHaveBeenCalled();
    expect(mocks.resolveCliAgent).toHaveBeenCalledWith('polish');
    expect(mocks.resolveCliRunModel).not.toHaveBeenCalled();
    expect(mocks.expandRunInputs).not.toHaveBeenCalled();
  });

  it('passes instruction file contents before inline workflow instructions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-workflow-'));
    try {
      await fs.writeFile(
        path.join(root, 'prompt.md'),
        'Read this prompt from disk.\n',
      );
      const { runWorkflowAgent } = await import('@cli/commands/workflow');

      const exitCode = await runWorkflowAgent(cliContext({ cwd: root }), {
        agent: 'polish',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        model: 'deepseekT',
        instruction: 'Then keep the final response concise.',
        instructionFile: 'prompt.md',
      });

      expect(exitCode).toBe(0);
      expect(mocks.expandRunInputs).toHaveBeenCalledWith(
        ['paper.tex'],
        [],
        root,
        { stdinInputFile: mocks.stdinInputFile },
      );
      const request = mocks.executeCliRequest.mock.calls[0]?.[0];
      expect(request?.config.instruction).toBe(
        'Read this prompt from disk.\n\nThen keep the final response concise.',
      );
      expect(mocks.stdinInputFile.cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing instruction files before starting platform or input work', async () => {
    const { runWorkflowAgent } = await import('@cli/commands/workflow');

    await expect(
      runWorkflowAgent(cliContext(), {
        agent: 'polish',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        instruction: '',
        instructionFile: 'missing-prompt.md',
      }),
    ).rejects.toThrow(/--instruction-file: file not found: missing-prompt\.md/);

    expect(mocks.initLocalCliPlatform).not.toHaveBeenCalled();
    expect(mocks.resolveCliAgent).not.toHaveBeenCalled();
    expect(mocks.resolveCliRunModel).not.toHaveBeenCalled();
    expect(mocks.expandRunInputs).not.toHaveBeenCalled();
  });
});
