import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { CliContext } from '@cli/runtime/cliContext';
import type {
  CliConfigExecuteOptions,
  CliConfigExecuteResult,
} from '@cli/runtime/runExecution';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { EXECUTION_STATUS, RUN_OUTCOME } from '@shared/schemas';

const mocks = vi.hoisted(() => {
  return {
    executeCliConfig: vi.fn(),
    emitCliResult: vi.fn(),
    finalizeExecution: vi.fn(),
    withExpandedRunInputs: vi.fn(),
    initLocalCliPlatform: vi.fn(),
    isAuthenticated: vi.fn(),
    resolveCliLaunchAgent: vi.fn(),
    selectCliRunModel: vi.fn(),
    writeErrorStderr: vi.fn(),
    writeResultMeta: vi.fn(),
    writeTextStderr: vi.fn(),
  };
});

vi.mock('@agent/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage')>()),
  getExecutionStore: vi.fn(() => ({
    writeResultMeta: mocks.writeResultMeta,
  })),
  finalizeExecution: mocks.finalizeExecution,
}));

vi.mock('@agent/index', () => ({
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getVisibleAgents: vi.fn(),
  loadAgents: vi.fn(),
}));

vi.mock('@utils/files', () => ({
  getRunDir: vi.fn((executionId: string) => `/tmp/runs/${executionId}`),
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
  buildHeadlessRunContext: vi.fn((context: CliContext) => ({
    ...context,
    quietLogs: true,
    renderRunProgress: false,
  })),
  selectCliRunModel: mocks.selectCliRunModel,
}));

vi.mock('@cli/commands/_helpers/output', () => ({
  emitCliResult: mocks.emitCliResult,
}));

vi.mock('@cli/runtime/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/agents')>()),
  resolveCliLaunchAgent: mocks.resolveCliLaunchAgent,
}));

vi.mock('@cli/runtime/runExecution', () => ({
  executeCliConfig: mocks.executeCliConfig,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeErrorStderr: mocks.writeErrorStderr,
  writeTextStderr: mocks.writeTextStderr,
}));

vi.mock('@cli/runtime/workflowInputs', () => ({
  withExpandedRunInputs: mocks.withExpandedRunInputs,
  hasMixedStdinWorkflowInputSpecs: vi.fn((inputFiles: readonly string[]) => {
    const specs = new Set(
      inputFiles.map((spec) => spec.trim()).filter(Boolean),
    );
    return specs.has('-') && specs.size > 1;
  }),
  isMaterializedStdinWorkflowInputPath: vi.fn(() => false),
  STDIN_WORKFLOW_INPUT_BASENAME: 'stdin.tex',
}));

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    renderRunProgress: true,
    ...overrides,
  });
}

function mockWorkflowExecution(
  result: CliConfigExecuteResult<typeof AgentCategory.Workflow>,
  once = false,
): void {
  const implementation = async (
    _config: unknown,
    _context: unknown,
    options: {
      readonly openWorkflowOutput?: CliConfigExecuteOptions['openWorkflowOutput'];
    },
  ) => {
    if (result.ok) await options.openWorkflowOutput?.(result.result);
    return result;
  };
  if (once) mocks.executeCliConfig.mockImplementationOnce(implementation);
  else mocks.executeCliConfig.mockImplementation(implementation);
}

describe('CLI workflow run command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.finalizeExecution.mockResolvedValue({
      status: 'durable',
      terminalStatusPersisted: true,
      flowRecord: 'deleted',
    });
    mocks.resolveCliLaunchAgent.mockResolvedValue({
      name: 'polish',
      category: AgentCategory.Workflow,
      source: 'builtInWorkflow',
      path: '/agents/polish.yaml',
      tools: [],
    });
    mocks.selectCliRunModel.mockImplementation(
      async (_context: CliContext, model: string | undefined) =>
        model ?? 'deepseekT',
    );
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
      ) => run({ inputFiles: ['paper.tex'], contextFiles: [] }),
    );
    mockWorkflowExecution({
      ok: true,
      executionId: 'exec-1',
      result: {
        category: AgentCategory.Workflow,
        executionId: 'exec-1',
        streamId: 'stream-1',
        outcome: RUN_OUTCOME.COMPLETED,
        outputs: [],
        compileFailures: [],
      },
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
    expect(mocks.resolveCliLaunchAgent).not.toHaveBeenCalled();
    expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });

  it('reports missing workflow agents before resolving the model', async () => {
    mocks.resolveCliLaunchAgent.mockRejectedValueOnce(
      new Error(
        'Agent not found: missing-agent. Use `texra agents list` for visible starter agents, `texra agents list --all` for the full catalog, or pass a known launchable agent name from a team preset.',
      ),
    );
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
      mocks.resolveCliLaunchAgent.mock.invocationCallOrder[0],
    );
    expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith(
      'missing-agent',
      'run',
    );
    expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });

  it('reports tool-use agents before resolving the model', async () => {
    mocks.resolveCliLaunchAgent.mockRejectedValueOnce(
      new Error(
        'Agent "chat" is a toolUse agent; `texra run` only handles workflow agents.',
      ),
    );
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
    expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith('chat', 'run');
    expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
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
    expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith('polish', 'run');
    expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });

  it('reports input expansion errors before resolving the model', async () => {
    mocks.withExpandedRunInputs.mockRejectedValueOnce(
      new Error('At least one workflow input file is required.'),
    );
    const { runWorkflowAgent } = await import('@cli/commands/workflow');

    await expect(
      runWorkflowAgent(cliContext(), {
        agent: 'polish',
        inputFiles: [],
        contextFiles: [],
        instruction: '',
      }),
    ).rejects.toThrow('At least one workflow input file is required.');

    expect(mocks.initLocalCliPlatform).toHaveBeenCalled();
    expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith('polish', 'run');
    expect(mocks.withExpandedRunInputs).toHaveBeenCalledWith(
      [],
      [],
      '/tmp/project',
      { readStdinText: expect.any(Function) },
      expect.any(Function),
    );
    expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
    expect(mocks.executeCliConfig).not.toHaveBeenCalled();
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
      expect(mocks.withExpandedRunInputs).toHaveBeenCalledWith(
        ['paper.tex'],
        [],
        root,
        { readStdinText: expect.any(Function) },
        expect.any(Function),
      );
      const config = mocks.executeCliConfig.mock.calls[0]?.[0];
      expect(config?.instruction).toBe(
        'Read this prompt from disk.\n\nThen keep the final response concise.',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('enforces workflow results at the shared execution boundary', async () => {
    const { runWorkflowAgent } = await import('@cli/commands/workflow');

    const exitCode = await runWorkflowAgent(cliContext(), {
      agent: 'polish',
      inputFiles: ['paper.tex'],
      contextFiles: [],
      instruction: '',
    });

    expect(exitCode).toBe(0);
    expect(mocks.executeCliConfig.mock.calls[0]?.[2]).toMatchObject({
      enforceCategory: true,
      expectedCategory: AgentCategory.Workflow,
      categoryMismatchMessage: 'Agent "polish" resolved to a non workflow run.',
    });
  });

  it('keeps the single-output copy target separate from workflow output names', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-workflow-'));
    try {
      const generated = path.join(root, 'run', 'r1', 'paper.tex');
      const outputSummary = {
        round: 1,
        relativePath: 'r1/paper.tex',
        absolutePath: generated,
        location: 'runStorage',
        originalPath: path.join(root, 'paper.tex'),
        added: null,
        removed: null,
      } as const;
      const compileFailure = {
        round: 1,
        displayName: 'paper.tex',
        outputPath: 'r1/paper.tex',
        logPath: 'compile/r1_paper.tex.log',
        logAbsolutePath: path.join(root, 'run', 'compile', 'r1_paper.tex.log'),
      };
      await fs.mkdir(path.dirname(generated), { recursive: true });
      await fs.writeFile(generated, 'polished');
      mockWorkflowExecution(
        {
          ok: true,
          executionId: 'exec-output',
          result: {
            category: AgentCategory.Workflow,
            executionId: 'exec-output',
            streamId: 'stream-output',
            outcome: RUN_OUTCOME.COMPLETED,
            outputs: [outputSummary],
            compileFailures: [compileFailure],
          },
        },
        true,
      );

      const { runWorkflowAgent } = await import('@cli/commands/workflow');

      const exitCode = await runWorkflowAgent(cliContext({ cwd: root }), {
        agent: 'polish',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        output: 'polished.tex',
        instruction: '',
      });

      expect(exitCode).toBe(0);
      const config = mocks.executeCliConfig.mock.calls[0]?.[0];
      expect(config).toMatchObject({
        inputFiles: ['paper.tex'],
        outputFiles: [],
        cliOutputFile: 'polished.tex',
      });
      await expect(
        fs.readFile(path.join(root, 'polished.tex'), 'utf8'),
      ).resolves.toBe('polished');
      expect(mocks.writeResultMeta).toHaveBeenCalledWith({
        producer: 'cliWorkflow',
        copiedOutput: path.join(root, 'polished.tex'),
        result: {
          category: 'workflow',
          outcome: RUN_OUTCOME.COMPLETED,
          outputs: [outputSummary],
          compileFailures: [compileFailure],
          diffs: [],
          cost: 0,
        },
      });
      const emission = mocks.emitCliResult.mock.calls[0]?.[1];
      expect(emission?.json).toMatchObject({
        outcome: RUN_OUTCOME.COMPLETED,
        status: EXECUTION_STATUS.COMPLETED,
        endGroupStatus: 'stopped',
        terminalStatus: EXECUTION_STATUS.COMPLETED,
        workingDirectory: root,
        runDirectory: '/tmp/runs/exec-output',
        copiedOutput: path.join(root, 'polished.tex'),
      });
      expect(Object.keys(emission?.json ?? {})).toEqual([
        'category',
        'executionId',
        'streamId',
        'outcome',
        'outputs',
        'compileFailures',
        'status',
        'endGroupStatus',
        'terminalStatus',
        'workingDirectory',
        'runDirectory',
        'copiedOutput',
      ]);
      expect(emission?.ndjson).toEqual({
        kind: 'result',
        result: emission.json,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('persists copied output-dir paths for history details', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-workflow-'));
    try {
      const generated = path.join(root, 'run', 'r1', 'paper.tex');
      const outputSummary = {
        round: 1,
        relativePath: 'r1/paper.tex',
        absolutePath: generated,
        location: 'runStorage',
        originalPath: path.join(root, 'paper.tex'),
        added: null,
        removed: null,
      } as const;
      await fs.mkdir(path.dirname(generated), { recursive: true });
      await fs.writeFile(generated, 'polished');
      mockWorkflowExecution(
        {
          ok: true,
          executionId: 'exec-output-dir',
          result: {
            category: AgentCategory.Workflow,
            executionId: 'exec-output-dir',
            streamId: 'stream-output-dir',
            outcome: RUN_OUTCOME.COMPLETED,
            outputs: [outputSummary],
            compileFailures: [],
          },
        },
        true,
      );

      const { runWorkflowAgent } = await import('@cli/commands/workflow');

      const exitCode = await runWorkflowAgent(cliContext({ cwd: root }), {
        agent: 'polish',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        outputDir: 'out',
        instruction: '',
      });

      expect(exitCode).toBe(0);
      await expect(
        fs.readFile(path.join(root, 'out', 'paper.tex'), 'utf8'),
      ).resolves.toBe('polished');
      expect(mocks.writeResultMeta).toHaveBeenCalledWith({
        producer: 'cliWorkflow',
        copiedOutputs: [path.join(root, 'out', 'paper.tex')],
        result: {
          category: 'workflow',
          outcome: RUN_OUTCOME.COMPLETED,
          outputs: [outputSummary],
          compileFailures: [],
          diffs: [],
          cost: 0,
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not fail a completed workflow when copied output metadata cannot be persisted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-workflow-'));
    try {
      const generated = path.join(root, 'run', 'r1', 'paper.tex');
      await fs.mkdir(path.dirname(generated), { recursive: true });
      await fs.writeFile(generated, 'polished');
      mockWorkflowExecution(
        {
          ok: true,
          executionId: 'exec-output-meta-fail',
          result: {
            category: AgentCategory.Workflow,
            executionId: 'exec-output-meta-fail',
            streamId: 'stream-output-meta-fail',
            outcome: RUN_OUTCOME.COMPLETED,
            outputs: [
              {
                round: 1,
                relativePath: 'r1/paper.tex',
                absolutePath: generated,
                location: 'runStorage',
                originalPath: path.join(root, 'paper.tex'),
                added: null,
                removed: null,
              },
            ],
            compileFailures: [],
          },
        },
        true,
      );
      mocks.writeResultMeta.mockRejectedValueOnce(
        new Error('metadata disk full'),
      );

      const { runWorkflowAgent } = await import('@cli/commands/workflow');

      const exitCode = await runWorkflowAgent(cliContext({ cwd: root }), {
        agent: 'polish',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        outputDir: 'out',
        instruction: '',
      });

      expect(exitCode).toBe(0);
      await expect(
        fs.readFile(path.join(root, 'out', 'paper.tex'), 'utf8'),
      ).resolves.toBe('polished');
      expect(mocks.emitCliResult).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          json: expect.objectContaining({
            copiedOutputs: [path.join(root, 'out', 'paper.tex')],
          }),
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('persists a failed runtime envelope when copying the requested output fails', async () => {
    const outputSummary = {
      round: 1,
      relativePath: 'r1/paper.tex',
      absolutePath: '/missing/run/r1/paper.tex',
      location: 'runStorage',
      originalPath: '/workspace/paper.tex',
      added: null,
      removed: null,
    } as const;
    mockWorkflowExecution(
      {
        ok: true,
        executionId: 'exec-copy-fail',
        result: {
          category: AgentCategory.Workflow,
          executionId: 'exec-copy-fail',
          streamId: 'stream-copy-fail',
          outcome: RUN_OUTCOME.COMPLETED,
          outputs: [outputSummary],
          compileFailures: [],
        },
      },
      true,
    );

    const { runWorkflowAgent } = await import('@cli/commands/workflow');
    const exitCode = await runWorkflowAgent(cliContext(), {
      agent: 'polish',
      inputFiles: ['paper.tex'],
      contextFiles: [],
      output: 'polished.tex',
      instruction: '',
    });

    expect(exitCode).toBe(CliExitCode.AgentError);
    expect(mocks.writeResultMeta).toHaveBeenCalledWith({
      producer: 'cliWorkflow',
      result: {
        category: 'workflow',
        outcome: RUN_OUTCOME.FAILED,
        outputs: [outputSummary],
        compileFailures: [],
        diffs: [],
        cost: 0,
      },
    });
    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      executionId: 'exec-copy-fail',
      terminalStatus: EXECUTION_STATUS.ERROR,
      flowRecord: 'delete',
    });
  });

  it('keeps a copy error primary when execution finalization also fails', async () => {
    mockWorkflowExecution(
      {
        ok: true,
        executionId: 'exec-copy-fail',
        result: {
          category: AgentCategory.Workflow,
          executionId: 'exec-copy-fail',
          streamId: 'stream-copy-fail',
          outcome: RUN_OUTCOME.COMPLETED,
          outputs: [
            {
              round: 1,
              relativePath: 'r1/paper.tex',
              absolutePath: '/missing/run/r1/paper.tex',
              location: 'runStorage',
              originalPath: '/workspace/paper.tex',
              added: null,
              removed: null,
            },
          ],
          compileFailures: [],
        },
      },
      true,
    );
    mocks.finalizeExecution.mockResolvedValueOnce({
      status: 'failed',
      error: new Error('terminal metadata disk full'),
      stage: 'terminal-status',
      terminalStatusPersisted: false,
    });

    const { runWorkflowAgent } = await import('@cli/commands/workflow');
    await expect(
      runWorkflowAgent(cliContext(), {
        agent: 'polish',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        output: 'polished.tex',
        instruction: '',
      }),
    ).resolves.toBe(CliExitCode.AgentError);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'Warning: Failed to persist error status for execution exec-copy-fail: terminal metadata disk full',
    );
    expect(mocks.writeErrorStderr).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('uses the resolved terminal outcome in the persisted envelope', async () => {
    mockWorkflowExecution(
      {
        ok: true,
        executionId: 'exec-interrupted',
        result: {
          category: AgentCategory.Workflow,
          executionId: 'exec-interrupted',
          streamId: 'stream-interrupted',
          outcome: RUN_OUTCOME.CANCELLED,
          outputs: [],
          compileFailures: [],
        },
      },
      true,
    );

    const { runWorkflowAgent } = await import('@cli/commands/workflow');
    const exitCode = await runWorkflowAgent(cliContext(), {
      agent: 'polish',
      inputFiles: ['paper.tex'],
      contextFiles: [],
      instruction: '',
    });

    expect(exitCode).toBe(CliExitCode.Interrupted);
    expect(mocks.writeResultMeta).toHaveBeenCalledWith({
      producer: 'cliWorkflow',
      result: {
        category: 'workflow',
        outcome: RUN_OUTCOME.CANCELLED,
        outputs: [],
        compileFailures: [],
        diffs: [],
        cost: 0,
      },
    });
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
    expect(mocks.resolveCliLaunchAgent).not.toHaveBeenCalled();
    expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
    expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
  });
});
