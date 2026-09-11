/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared mock registrations must evaluate before anything that loads
// the mocked modules — keep these imports immediately after the vitest
// import (enforced by architecture/supportMockImportOrder.vitest.ts).
import '@test/support/agentCatalogMock';
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { cliLogSinksMock } from '@test/support/cliLogSinksMock';

import { it as effectIt } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { ensureError } from '@utils/errors/errorMessage';
import type { runWorkflowAgent } from '@cli/commands/workflow';
import { formatResumeCommand } from '@cli/chat/tui/state/resumeHint';
import type { CliContext } from '@cli/runtime/cliContext';
import type {
  CliConfigExecuteOptions,
  CliConfigExecuteResult,
} from '@cli/runtime/executeCli';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { RUN_OUTCOME, type RunId, AgentCategory } from '@shared/schemas';
import { createRunCommandCliContext } from '@test/cli/fixtures/cliContext';
import { durableFinalizationResult } from '@test/support/agentStorageFixtures';
import { withTempDir } from '@test/support/tempDirPlatform';

const mocks = vi.hoisted(() => {
  return {
    executeCliConfig: vi.fn(),
    emitCliResult: vi.fn(),
    finalizeRun: vi.fn(),
    withExpandedRunInputs: vi.fn(),
    resolveCliLaunchAgent: vi.fn(),
    selectCliRunModel: vi.fn(),
    deriveResumability: vi.fn(),
    writeResultMeta: vi.fn(),
  };
});

vi.mock('@agent/storage', async (importOriginal) => {
  const { createFakeRunRecords } = await import('@test/support/FakeRunKVStore');
  return {
    ...(await importOriginal<typeof import('@agent/storage')>()),
    getRunRecords: vi.fn(() =>
      createFakeRunRecords({
        writeResultMeta: (meta) =>
          Effect.tryPromise({
            try: () => mocks.writeResultMeta(meta),
            catch: ensureError,
          }),
      }),
    ),
    deriveResumability: (...args: unknown[]) =>
      Effect.tryPromise(() => mocks.deriveResumability(...args)),
    finalizeRun: (...args: unknown[]) =>
      Effect.tryPromise(() => mocks.finalizeRun(...args)),
  };
});

vi.mock('@utils/files/runStorageFs', async (importActual) => ({
  ...(await importActual<typeof import('@utils/files/runStorageFs')>()),
  getRunDir: vi.fn((runId: string) => `/tmp/runs/${runId}`),
}));

vi.mock('@cli/runtime/runModel', () => ({
  buildHeadlessRunContext: vi.fn((context: CliContext) => ({
    ...context,
    quietLogs: true,
    renderRunProgress: false,
  })),
  selectCliRunModel: mocks.selectCliRunModel,
}));

vi.mock('@cli/commands/_helpers/output', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/commands/_helpers/output')>()),
  emitCliResult: mocks.emitCliResult,
}));

vi.mock('@cli/runtime/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/agents')>()),
  resolveCliLaunchAgent: mocks.resolveCliLaunchAgent,
}));

vi.mock('@cli/runtime/transcriptSession', () => ({
  initializeCliTranscriptSession: vi.fn(async () => ({})),
}));

vi.mock('@cli/runtime/executeCli', () => ({
  executeCliConfig: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.executeCliConfig(...args),
      catch: ensureError,
    }),
}));

vi.mock('@cli/runtime/workflowInputs', () => ({
  withExpandedRunInputs: (
    ...args: Parameters<
      typeof import('@cli/runtime/workflowInputs').withExpandedRunInputs
    >
  ) =>
    Effect.tryPromise({
      try: () =>
        mocks.withExpandedRunInputs(
          ...args.slice(0, 4),
          (inputs: Parameters<(typeof args)[4]>[0]) =>
            Effect.runPromise(args[4](inputs)),
        ),
      catch: ensureError,
    }),
  hasMixedStdinWorkflowInputSpecs: vi.fn((inputFiles: readonly string[]) => {
    const specs = new Set(
      inputFiles.map((spec) => spec.trim()).filter(Boolean),
    );
    return specs.has('-') && specs.size > 1;
  }),
  STDIN_WORKFLOW_INPUT_BASENAME: 'stdin.tex',
}));

type WorkflowRunInit = Parameters<typeof runWorkflowAgent>[1];
type WorkflowExecuteResult = CliConfigExecuteResult<
  typeof AgentCategory.Workflow
>;
type WorkflowRunPayload = Extract<
  WorkflowExecuteResult,
  { ok: true }
>['result'];

function expectedRecoveryHint(
  context: CliContext,
  runId: string,
  workingDirectory = context.cwd,
): string {
  return `Resume this workflow with: ${formatResumeCommand(
    context.commandName,
    runId,
    {
      cwd: workingDirectory,
      processCwd: process.cwd(),
      approvalPolicy: context.approvalPolicy,
      outputFormat: context.outputFormat,
      print: context.mode === 'headless',
      includeInteropSkills: context.skillSourceOptions.includeInterop,
      skillSourcePaths: context.skillSourceOptions.additionalPaths,
    },
  )}`;
}

/** Runs the workflow command with the shared happy-path inputs. */
async function runWorkflow(
  init: Partial<WorkflowRunInit> = {},
  context: CliContext = createRunCommandCliContext(),
): Promise<number> {
  const { runWorkflowAgent: run } = await import('@cli/commands/workflow');
  return Effect.runPromise(
    run(context, {
      agent: 'polish',
      inputFiles: ['paper.tex'],
      contextFiles: [],
      instruction: '',
      ...init,
    }),
  );
}

function runOutputSummary(absolutePath: string, originalPath: string) {
  return {
    round: 1,
    relativePath: 'r1/paper.tex',
    absolutePath,
    location: 'runStorage',
    originalPath,
    added: null,
    removed: null,
  } as const;
}

function workflowRun(
  runId: string,
  overrides: Partial<
    Pick<WorkflowRunPayload, 'outcome' | 'outputs' | 'compileFailures'>
  > = {},
): WorkflowExecuteResult {
  return {
    ok: true,
    runId,
    outcomePersisted: true,
    result: {
      category: AgentCategory.Workflow,
      runId: runId as RunId,
      outcome: RUN_OUTCOME.COMPLETED,
      outputs: [],
      compileFailures: [],
      ...overrides,
    },
  };
}

function mockWorkflowRun(result: WorkflowExecuteResult, once = false): void {
  const implementation = async (
    _config: unknown,
    _context: unknown,
    options: {
      readonly openWorkflowOutput?: CliConfigExecuteOptions['openWorkflowOutput'];
    },
  ) => {
    if (result.ok) {
      const outputOutcome = options.openWorkflowOutput
        ? await Effect.runPromise(
            options.openWorkflowOutput(result.result, () => true),
          )
        : undefined;
      if (outputOutcome !== undefined) {
        return {
          ...result,
          result: { ...result.result, outcome: outputOutcome },
        };
      }
    }
    return result;
  };
  if (once) mocks.executeCliConfig.mockImplementationOnce(implementation);
  else mocks.executeCliConfig.mockImplementation(implementation);
}

/** Mocks a run whose cancellation lands during output finalization. */
function mockCancellationDuringOutputFinalization(
  provisional: WorkflowExecuteResult,
  tryCommitPublication: () => boolean,
): void {
  if (!provisional.ok) throw new Error('Expected a workflow result.');
  mocks.executeCliConfig.mockImplementationOnce(
    async (
      _config: unknown,
      _context: unknown,
      options: {
        readonly openWorkflowOutput?: CliConfigExecuteOptions['openWorkflowOutput'];
      },
    ) => {
      if (options.openWorkflowOutput)
        await Effect.runPromise(
          options.openWorkflowOutput(provisional.result, tryCommitPublication),
        );
      return {
        ...provisional,
        result: {
          ...provisional.result,
          outcome: RUN_OUTCOME.CANCELLED,
        },
      };
    },
  );
}

/** The result envelope the command persists for history details. */
function expectedResultMeta(options: {
  readonly outcome: string;
  readonly outputs: readonly unknown[];
  readonly compileFailures: readonly unknown[];
  readonly copiedOutput?: string;
  readonly copiedOutputs?: readonly string[];
}): Record<string, unknown> {
  const { outcome, outputs, compileFailures, ...copies } = options;
  return {
    producer: 'cliWorkflow',
    ...copies,
    result: {
      category: 'workflow',
      outcome,
      outputs,
      compileFailures,
      diffs: [],
      cost: 0,
    },
  };
}

/** Materializes the round-1 output file the copy target is sourced from. */
async function writeGeneratedOutput(root: string): Promise<string> {
  const generated = path.join(root, 'run', 'r1', 'paper.tex');
  await fs.mkdir(path.dirname(generated), { recursive: true });
  await fs.writeFile(generated, 'polished');
  return generated;
}

/** Cancelled-run fixture: real source file plus a cancelled run mock. */
async function setupCancelledOutput(
  root: string,
  runId: string,
): Promise<ReturnType<typeof runOutputSummary>> {
  const generated = await writeGeneratedOutput(root);
  const outputSummary = runOutputSummary(
    generated,
    path.join(root, 'paper.tex'),
  );
  mockWorkflowRun(
    workflowRun(runId, {
      outcome: RUN_OUTCOME.CANCELLED,
      outputs: [outputSummary],
    }),
    true,
  );
  return outputSummary;
}

function expectNoModelOrInputWork(): void {
  expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
  expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
}

describe('CLI workflow run command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliInitPlatformMock.initLocalCliPlatform.mockResolvedValue(undefined);
    cliInitPlatformMock.initCliPlatform.mockResolvedValue(undefined);
    mocks.writeResultMeta.mockResolvedValue(undefined);
    mocks.finalizeRun.mockResolvedValue(durableFinalizationResult());
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
    mocks.deriveResumability.mockResolvedValue({
      kind: 'checkpoint',
      flowRecord: {
        shared: {},
        cursor: { nextNodeId: 'start' },
      },
    });
    mocks.withExpandedRunInputs.mockImplementation(
      async (
        _inputSpecs: readonly string[],
        _contextSpecs: readonly string[],
        _cwd: string,
        _options: unknown,
        run: (inputs: {
          readonly inputFiles: string[];
          readonly contextFiles: string[];
          readonly stdinInputPath?: string;
        }) => Promise<unknown>,
      ) => run({ inputFiles: ['paper.tex'], contextFiles: [] }),
    );
    mockWorkflowRun(workflowRun('exec-1'));
  });

  it('reports conflicting output targets before platform or model lookup', async () => {
    await expect(
      runWorkflow({ output: 'out.tex', outputDir: 'out' }),
    ).rejects.toThrow('Use either --output or --output-dir, not both.');

    expect(cliInitPlatformMock.initLocalCliPlatform).not.toHaveBeenCalled();
    expect(mocks.resolveCliLaunchAgent).not.toHaveBeenCalled();
    expectNoModelOrInputWork();
  });

  it('reports single-output mixed stdin usage before resolving the model', async () => {
    await expect(
      runWorkflow({ inputFiles: ['-', 'paper.tex'], output: 'out.tex' }),
    ).rejects.toThrow(
      'Use --output-dir for multi-input workflow runs; --output is only for a single final artifact.',
    );

    expect(cliInitPlatformMock.initLocalCliPlatform).toHaveBeenCalled();
    expect(mocks.resolveCliLaunchAgent).toHaveBeenCalledWith('polish', 'run');
    expectNoModelOrInputWork();
  });

  it('passes instruction file contents before inline workflow instructions', async () => {
    await withTempDir('texra-workflow-', async (root) => {
      await fs.writeFile(
        path.join(root, 'prompt.md'),
        'Read this prompt from disk.\n',
      );

      const exitCode = await runWorkflow(
        {
          model: 'deepseekT',
          instruction: 'Then keep the final response concise.',
          instructionFile: 'prompt.md',
        },
        createRunCommandCliContext({ cwd: root }),
      );

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
    });
  });

  it('enforces workflow results at the shared run boundary', async () => {
    const exitCode = await runWorkflow();

    expect(exitCode).toBe(0);
    expect(mocks.executeCliConfig.mock.calls[0]?.[2]).toMatchObject({
      expectedCategory: AgentCategory.Workflow,
      categoryMismatchMessage: 'Agent "polish" resolved to a non workflow run.',
    });
  });

  it('keeps the single-output copy target separate from workflow output names', async () => {
    await withTempDir('texra-workflow-', async (root) => {
      const generated = await writeGeneratedOutput(root);
      const outputSummary = runOutputSummary(
        generated,
        path.join(root, 'paper.tex'),
      );
      const compileFailure = {
        round: 1,
        displayName: 'paper.tex',
        outputPath: 'r1/paper.tex',
        logPath: 'compile/r1_paper.tex.log',
        logAbsolutePath: path.join(root, 'run', 'compile', 'r1_paper.tex.log'),
      };
      mockWorkflowRun(
        workflowRun('exec-output', {
          outputs: [outputSummary],
          compileFailures: [compileFailure],
        }),
        true,
      );

      const exitCode = await runWorkflow(
        { output: 'polished.tex' },
        createRunCommandCliContext({ cwd: root }),
      );

      expect(exitCode).toBe(0);
      const config = mocks.executeCliConfig.mock.calls[0]?.[0];
      expect(config).toMatchObject({
        inputFiles: ['paper.tex'],
        outputFiles: [],
        cli: {
          outputFile: path.join(root, 'polished.tex'),
          outputDirectory: undefined,
          expectedOutputFiles: undefined,
        },
      });
      await expect(
        fs.readFile(path.join(root, 'polished.tex'), 'utf8'),
      ).resolves.toBe('polished');
      expect(mocks.writeResultMeta).toHaveBeenCalledWith(
        expectedResultMeta({
          copiedOutput: path.join(root, 'polished.tex'),
          outcome: RUN_OUTCOME.COMPLETED,
          outputs: [outputSummary],
          compileFailures: [compileFailure],
        }),
      );
      const emission = mocks.emitCliResult.mock.calls[0]?.[1];
      expect(emission?.json).toMatchObject({
        outcome: RUN_OUTCOME.COMPLETED,
        workingDirectory: root,
        runDirectory: '/tmp/runs/exec-output',
        copiedOutput: path.join(root, 'polished.tex'),
      });
      // The v0.41 cut removed the three deprecated status projections, so the
      // emitted object is the run result plus its filesystem metadata, in the
      // order `resolveWorkflowOutput` builds it, with the run id moved to the
      // frozen 0.40 wire key by `cliRunResultPayload`.
      expect(Object.keys(emission?.json ?? {})).toEqual([
        'category',
        'outcome',
        'outputs',
        'compileFailures',
        'workingDirectory',
        'runDirectory',
        'copiedOutput',
        'executionId',
      ]);
      expect(emission?.ndjson).toEqual({
        kind: 'result',
        result: emission.json,
      });
    });
  });

  it('persists copied output-dir paths for history details', async () => {
    await withTempDir('texra-workflow-', async (root) => {
      const workspace = path.join(root, 'workspace ');
      const generated = await writeGeneratedOutput(workspace);
      const outputSummary = runOutputSummary(
        generated,
        path.join(workspace, 'paper.tex'),
      );
      mockWorkflowRun(
        workflowRun('exec-output-dir', { outputs: [outputSummary] }),
        true,
      );

      const exitCode = await runWorkflow(
        { outputDir: 'out' },
        createRunCommandCliContext({ cwd: workspace }),
      );

      expect(exitCode).toBe(0);
      expect(mocks.executeCliConfig.mock.calls[0]?.[0]).toMatchObject({
        cli: {
          outputFile: undefined,
          outputDirectory: path.join(workspace, 'out'),
          expectedOutputFiles: ['paper.tex'],
        },
      });
      await expect(
        fs.readFile(path.join(workspace, 'out', 'paper.tex'), 'utf8'),
      ).resolves.toBe('polished');
      expect(mocks.writeResultMeta).toHaveBeenCalledWith(
        expectedResultMeta({
          copiedOutputs: [path.join(workspace, 'out', 'paper.tex')],
          outcome: RUN_OUTCOME.COMPLETED,
          outputs: [outputSummary],
          compileFailures: [],
        }),
      );
    });
  });

  effectIt.live(
    'persists workflow metadata before the run claim is released',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { createTestSession } = yield* Effect.promise(
            () => import('@test/support/sessionTestUtils'),
          );
          const { aggregateId } = yield* Effect.promise(
            () => import('@shared/schemas'),
          );
          const storage = yield* Effect.promise(() =>
            vi.importActual<typeof import('@agent/storage')>('@agent/storage'),
          );
          const mockedStorage = yield* Effect.promise(
            () => import('@agent/storage'),
          );
          const { initializeCliTranscriptSession } = yield* Effect.promise(
            () => import('@cli/runtime/transcriptSession'),
          );
          const session = yield* Effect.acquireRelease(
            Effect.sync(() => createTestSession()),
            (owned) => Effect.sync(() => owned.dispose()),
          );
          const runId = 'abc123abc123' as RunId;
          const { runInSession } = yield* Effect.promise(
            () => import('@agent/runtime/RunContext'),
          );
          const { acquireFreshRunLease } = yield* Effect.promise(
            () => import('@agent/storage/runLease'),
          );
          yield* Effect.promise(() =>
            runInSession(session, () => acquireFreshRunLease(runId)),
          );
          const run = workflowRun(runId);
          if (!run.ok) throw new Error('Expected workflow result.');
          vi.mocked(initializeCliTranscriptSession).mockResolvedValueOnce(
            session,
          );
          const records = storage.getRunRecords(session, runId);
          vi.mocked(mockedStorage.getRunRecords).mockReturnValueOnce(records);
          yield* session.commit([
            {
              type: 'run.start',
              aggregateId: aggregateId('run', run.result.runId),
              identity: { kind: 'agent', agent: 'polish' },
              category: AgentCategory.Workflow,
              userFollowUpSupport: 'unsupported',
              isRemote: false,
              parent: null,
            },
          ]);
          // The existing executeCliConfig stub is a Promise port. Its run owns
          // output finalization and releases the real claim before returning.
          mocks.executeCliConfig.mockImplementationOnce(
            (_config, _context, options) =>
              Effect.runPromise(
                options
                  .openWorkflowOutput(run.result, () => true)
                  .pipe(
                    Effect.as(run),
                    Effect.ensuring(
                      session.releaseRunLease(runId).pipe(Effect.orDie),
                    ),
                  ),
              ),
          );
          expect(
            yield* Effect.promise(() =>
              runWorkflow({}, createRunCommandCliContext()),
            ),
          ).toBe(0);
          expect(yield* records.readResultMeta()).toMatchObject({
            producer: 'cliWorkflow',
            result: { outcome: RUN_OUTCOME.COMPLETED },
          });
          const afterRelease = yield* Effect.result(
            records.writeResultMeta(
              storage.buildCliWorkflowResultMeta(run.result),
            ),
          );
          expect(Result.isFailure(afterRelease)).toBe(true);
        }),
      ),
  );

  it('reports failure when completed workflow metadata cannot be persisted', async () => {
    await withTempDir('texra-workflow-', async (root) => {
      const generated = await writeGeneratedOutput(root);
      mockWorkflowRun(
        workflowRun('exec-output-meta-fail', {
          outputs: [runOutputSummary(generated, path.join(root, 'paper.tex'))],
        }),
        true,
      );
      mocks.writeResultMeta.mockRejectedValueOnce(
        new Error('metadata disk full'),
      );

      await expect(
        runWorkflow(
          { outputDir: 'out' },
          createRunCommandCliContext({ cwd: root }),
        ),
      ).rejects.toThrow('metadata disk full');

      await expect(
        fs.readFile(path.join(root, 'out', 'paper.tex'), 'utf8'),
      ).resolves.toBe('polished');
      expect(mocks.emitCliResult).not.toHaveBeenCalled();
    });
  });

  it('persists a failed runtime envelope when copying the requested output fails', async () => {
    const outputSummary = runOutputSummary(
      '/missing/run/r1/paper.tex',
      '/workspace/paper.tex',
    );
    mockWorkflowRun(
      workflowRun('exec-copy-fail', { outputs: [outputSummary] }),
      true,
    );

    const exitCode = await runWorkflow({ output: 'polished.tex' });

    expect(exitCode).toBe(CliExitCode.AgentError);
    expect(mocks.writeResultMeta).toHaveBeenCalledWith(
      expectedResultMeta({
        outcome: RUN_OUTCOME.FAILED,
        outputs: [outputSummary],
        compileFailures: [],
      }),
    );
    expect(mocks.finalizeRun).not.toHaveBeenCalled();
  });

  it('prints a resumable recovery command after persisting a cancelled workflow', async () => {
    await withTempDir('texra-workflow-', async (root) => {
      mockWorkflowRun(
        workflowRun('exec-interrupted', {
          outcome: RUN_OUTCOME.CANCELLED,
        }),
        true,
      );

      const context = createRunCommandCliContext({
        cwd: root,
        commandName: 'texra-local',
        approvalPolicy: 'never',
      });
      const exitCode = await runWorkflow({ output: 'polished.tex' }, context);

      expect(exitCode).toBe(CliExitCode.Interrupted);
      await expect(fs.stat(path.join(root, 'polished.tex'))).rejects.toThrow();
      expect(mocks.writeResultMeta).toHaveBeenCalledWith(
        expectedResultMeta({
          outcome: RUN_OUTCOME.CANCELLED,
          outputs: [],
          compileFailures: [],
        }),
      );
      expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledExactlyOnceWith(
        expectedRecoveryHint(context, 'exec-interrupted'),
      );
      expect(mocks.writeResultMeta.mock.invocationCallOrder[0]).toBeLessThan(
        cliLogSinksMock.writeTextStderr.mock.invocationCallOrder[0],
      );
    });
  });

  it('keeps non-empty cancelled outputs in run storage without copying to --output', async () => {
    await withTempDir('texra-workflow-', async (root) => {
      const outputSummary = await setupCancelledOutput(
        root,
        'exec-cancelled-output',
      );

      const context = createRunCommandCliContext({
        cwd: root,
        commandName: 'texra-local',
        approvalPolicy: 'never',
      });
      const exitCode = await runWorkflow({ output: 'polished.tex' }, context);

      expect(exitCode).toBe(CliExitCode.Interrupted);
      // The destination did not previously exist and must stay absent.
      await expect(fs.stat(path.join(root, 'polished.tex'))).rejects.toThrow();
      expect(mocks.writeResultMeta).toHaveBeenCalledWith(
        expectedResultMeta({
          outcome: RUN_OUTCOME.CANCELLED,
          outputs: [outputSummary],
          compileFailures: [],
        }),
      );
      const emission = mocks.emitCliResult.mock.calls[0]?.[1];
      expect(emission?.json).toMatchObject({
        outcome: RUN_OUTCOME.CANCELLED,
        workingDirectory: root,
        runDirectory: '/tmp/runs/exec-cancelled-output',
      });
      expect(emission?.json).not.toHaveProperty('copiedOutput');
      expect(emission?.json).not.toHaveProperty('copiedOutputs');
      expect(emission?.text).toBe('/tmp/runs/exec-cancelled-output');
      expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledExactlyOnceWith(
        expectedRecoveryHint(context, 'exec-cancelled-output'),
      );
    });
  });

  it('keeps non-empty cancelled outputs in run storage without copying to --output-dir', async () => {
    await withTempDir('texra-workflow-', async (root) => {
      const outputSummary = await setupCancelledOutput(
        root,
        'exec-cancelled-output-dir',
      );

      const context = createRunCommandCliContext({
        cwd: root,
        commandName: 'texra-local',
        approvalPolicy: 'never',
      });
      const exitCode = await runWorkflow({ outputDir: 'out' }, context);

      expect(exitCode).toBe(CliExitCode.Interrupted);
      // The pre-flight probe may create the directory itself, but no output
      // file may be copied into it.
      await expect(
        fs.stat(path.join(root, 'out', 'paper.tex')),
      ).rejects.toThrow();
      expect(mocks.writeResultMeta).toHaveBeenCalledWith(
        expectedResultMeta({
          outcome: RUN_OUTCOME.CANCELLED,
          outputs: [outputSummary],
          compileFailures: [],
        }),
      );
      const emission = mocks.emitCliResult.mock.calls[0]?.[1];
      expect(emission?.json).toMatchObject({
        outcome: RUN_OUTCOME.CANCELLED,
        workingDirectory: root,
        runDirectory: '/tmp/runs/exec-cancelled-output-dir',
      });
      expect(emission?.json).not.toHaveProperty('copiedOutput');
      expect(emission?.json).not.toHaveProperty('copiedOutputs');
      expect(emission?.text).toBe('/tmp/runs/exec-cancelled-output-dir');
      expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledExactlyOnceWith(
        expectedRecoveryHint(context, 'exec-cancelled-output-dir'),
      );
    });
  });

  it.each([
    {
      label: '--output',
      init: { output: 'polished.tex' },
      destination: (root: string) => path.join(root, 'polished.tex'),
    },
    {
      label: '--output-dir',
      init: { outputDir: 'out' },
      destination: (root: string) => path.join(root, 'out', 'paper.tex'),
    },
  ])(
    'keeps failed output in run storage and preserves the requested $label destination',
    async ({ init, destination }) => {
      await withTempDir('texra-workflow-', async (root) => {
        const generated = await writeGeneratedOutput(root);
        const outputSummary = runOutputSummary(
          generated,
          path.join(root, 'paper.tex'),
        );
        mockWorkflowRun(
          workflowRun('exec-failed-output', {
            outcome: RUN_OUTCOME.FAILED,
            outputs: [outputSummary],
          }),
          true,
        );
        const target = destination(root);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, 'keep-me');

        const exitCode = await runWorkflow(
          init,
          createRunCommandCliContext({ cwd: root }),
        );

        expect(exitCode).toBe(CliExitCode.AgentError);
        await expect(fs.readFile(target, 'utf8')).resolves.toBe('keep-me');
        const emission = mocks.emitCliResult.mock.calls[0]?.[1];
        expect(emission?.json).toMatchObject({
          outcome: RUN_OUTCOME.FAILED,
          outputs: [outputSummary],
          runDirectory: '/tmp/runs/exec-failed-output',
        });
        expect(emission?.json).not.toHaveProperty('copiedOutput');
        expect(emission?.json).not.toHaveProperty('copiedOutputs');
        expect(emission?.text).toContain('FAILED');
        expect(emission?.text).toContain('/tmp/runs/exec-failed-output');
      });
    },
  );

  it('leaves a pre-existing --output destination untouched for a cancelled run', async () => {
    await withTempDir('texra-workflow-', async (root) => {
      const destination = path.join(root, 'polished.tex');
      await fs.writeFile(destination, 'keep-me');
      await setupCancelledOutput(root, 'exec-cancelled-existing-output');

      const exitCode = await runWorkflow(
        { output: 'polished.tex' },
        createRunCommandCliContext({ cwd: root }),
      );

      expect(exitCode).toBe(CliExitCode.Interrupted);
      await expect(fs.readFile(destination, 'utf8')).resolves.toBe('keep-me');
    });
  });

  it('presents the lifecycle verdict when cancellation lands during output finalization', async () => {
    mockCancellationDuringOutputFinalization(
      workflowRun('exec-output-interrupted'),
      () => true,
    );

    const exitCode = await runWorkflow();

    expect(exitCode).toBe(CliExitCode.Interrupted);
    expect(mocks.writeResultMeta).toHaveBeenCalledWith(
      expectedResultMeta({
        outcome: RUN_OUTCOME.COMPLETED,
        outputs: [],
        compileFailures: [],
      }),
    );
    expect(mocks.emitCliResult).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        json: expect.objectContaining({ outcome: RUN_OUTCOME.CANCELLED }),
      }),
    );
  });

  it.each([
    {
      label: '--output',
      state: 'missing',
      existing: false,
      init: { output: 'published.tex' },
      destination: (root: string) => path.join(root, 'published.tex'),
    },
    {
      label: '--output-dir',
      state: 'missing',
      existing: false,
      init: { outputDir: 'published' },
      destination: (root: string) => path.join(root, 'published', 'paper.tex'),
    },
    {
      label: '--output',
      state: 'existing',
      existing: true,
      init: { output: 'published.tex' },
      destination: (root: string) => path.join(root, 'published.tex'),
    },
    {
      label: '--output-dir',
      state: 'existing',
      existing: true,
      init: { outputDir: 'published' },
      destination: (root: string) => path.join(root, 'published', 'paper.tex'),
    },
  ])(
    'leaves a $state $label destination untouched when cancellation commits first',
    async ({ init, destination, existing }) => {
      await withTempDir('texra-workflow-', async (root) => {
        const generated = await writeGeneratedOutput(root);
        const outputSummary = runOutputSummary(
          generated,
          path.join(root, 'paper.tex'),
        );
        mockCancellationDuringOutputFinalization(
          workflowRun('exec-output-interrupted', {
            outputs: [outputSummary],
          }),
          () => false,
        );
        const target = destination(root);
        if (existing) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, 'existing');
        }

        const exitCode = await runWorkflow(
          init,
          createRunCommandCliContext({ cwd: root }),
        );

        expect(exitCode).toBe(CliExitCode.Interrupted);
        if (existing) {
          await expect(fs.readFile(target, 'utf8')).resolves.toBe('existing');
        } else {
          await expect(fs.stat(target)).rejects.toThrow();
        }
        expect(mocks.writeResultMeta).toHaveBeenCalledWith(
          expectedResultMeta({
            outcome: RUN_OUTCOME.COMPLETED,
            outputs: [outputSummary],
            compileFailures: [],
          }),
        );
        const emitted = mocks.emitCliResult.mock.calls[0]?.[1]?.json;
        expect(emitted).toMatchObject({
          outcome: RUN_OUTCOME.CANCELLED,
          runDirectory: '/tmp/runs/exec-output-interrupted',
        });
        expect(emitted).not.toHaveProperty('copiedOutput');
        expect(emitted).not.toHaveProperty('copiedOutputs');
      });
    },
  );

  it('does not advertise resume when cancelled status is not durable', async () => {
    const durableRun = workflowRun('exec-undurable', {
      outcome: RUN_OUTCOME.CANCELLED,
    });
    if (!durableRun.ok) throw new Error('Expected a workflow result.');
    mockWorkflowRun({ ...durableRun, outcomePersisted: false }, true);

    await expect(runWorkflow()).resolves.toBe(CliExitCode.Interrupted);

    expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
    expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalled();
  });

  it('does not advertise resume for temporary materialized stdin', async () => {
    const root = path.join(path.sep, 'tmp', 'workspace');
    const stdinPath = path.join(root, 'texra-stdin-123-abc123', 'stdin.tex');
    mocks.withExpandedRunInputs.mockImplementationOnce(
      async (_inputs, _contexts, _cwd, _options, run) =>
        run({
          inputFiles: [stdinPath],
          contextFiles: [],
          stdinInputPath: stdinPath,
        }),
    );
    mockWorkflowRun(
      workflowRun('exec-stdin-interrupted', {
        outcome: RUN_OUTCOME.CANCELLED,
      }),
      true,
    );

    await expect(
      runWorkflow(
        { inputFiles: ['-'] },
        createRunCommandCliContext({ cwd: root }),
      ),
    ).resolves.toBe(CliExitCode.Interrupted);

    expect(
      mocks.executeCliConfig.mock.calls[0]?.[2].onInterruptedRunFinalized,
    ).toBeUndefined();
    expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
    expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalled();
  });

  it('keeps recovery for a durable file whose name resembles stdin materialization', async () => {
    const lookalike = path.join(
      path.sep,
      'tmp',
      'workspace',
      'texra-stdin-123-abc123',
      'stdin.tex',
    );
    mocks.withExpandedRunInputs.mockImplementationOnce(
      async (_inputs, _contexts, _cwd, _options, run) =>
        run({ inputFiles: [lookalike], contextFiles: [] }),
    );
    mockWorkflowRun(
      workflowRun('exec-stdin-lookalike', {
        outcome: RUN_OUTCOME.CANCELLED,
      }),
      true,
    );

    await expect(runWorkflow()).resolves.toBe(CliExitCode.Interrupted);

    expect(
      mocks.executeCliConfig.mock.calls[0]?.[2].onInterruptedRunFinalized,
    ).toBeTypeOf('function');
    expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledOnce();
  });

  it('rejects recovery advertising for a checkpoint carrying a flow failure', async () => {
    await runWorkflow();
    const canAdvertise =
      mocks.executeCliConfig.mock.calls[0]?.[2].canAdvertiseInterruptedRun;

    expect(
      canAdvertise?.({
        kind: 'checkpoint',
        flowRecord: {
          shared: { lastError: { message: 'provider failed' } },
          cursor: { nextNodeId: 'start' },
        },
      }),
    ).toBe(false);
  });

  it('rejects recovery advertising for terminal unresolved compile rejection', async () => {
    await runWorkflow();
    const canAdvertise =
      mocks.executeCliConfig.mock.calls[0]?.[2].canAdvertiseInterruptedRun;

    expect(
      canAdvertise?.({
        kind: 'checkpoint',
        flowRecord: {
          shared: {
            currentRound: 1,
            totalRounds: 2,
            unresolvedCompileRejection: true,
          },
          cursor: { nextNodeId: 'start' },
        },
      }),
    ).toBe(false);
    expect(
      canAdvertise?.({
        kind: 'checkpoint',
        flowRecord: {
          shared: {
            currentRound: 0,
            totalRounds: 2,
            unresolvedCompileRejection: true,
          },
          cursor: { nextNodeId: 'start' },
        },
      }),
    ).toBe(true);
    expect(
      canAdvertise?.({
        kind: 'checkpoint',
        flowRecord: {
          shared: {
            currentRound: 1,
            totalRounds: 2,
            compileFailureContext: 'legacy compile failure',
          },
          cursor: { nextNodeId: 'start' },
        },
      }),
    ).toBe(false);
  });

  it('prints the durable shutdown hint once with the persisted workspace', async () => {
    const run = workflowRun('exec-signal', {
      outcome: RUN_OUTCOME.CANCELLED,
    });
    mocks.executeCliConfig.mockImplementationOnce(
      async (_config, _context, options) => {
        if (!run.ok) return run;
        if (options.openWorkflowOutput)
          await Effect.runPromise(
            options.openWorkflowOutput(run.result, () => true),
          );
        options.onInterruptedRunFinalized?.('exec-signal');
        return run;
      },
    );
    const resumeInvocation = path.join(path.sep, 'tmp', 'resume-invocation');
    const persistedWorkspace = path.join(
      path.sep,
      'tmp',
      'persisted-workspace',
    );
    const context = createRunCommandCliContext({ cwd: resumeInvocation });
    const { executeCliWorkflowConfig: nativeExecute } =
      await import('@cli/commands/workflow');
    const executeCliWorkflowConfig = (
      ...args: Parameters<typeof nativeExecute>
    ) => Effect.runPromise(nativeExecute(...args));

    const exitCode = await executeCliWorkflowConfig(
      {
        agent: 'polish',
        model: 'deepseekT',
        workingDirectory: persistedWorkspace,
        agentCategory: AgentCategory.Workflow,
      },
      context,
      { categoryMismatchMessage: 'unexpected category' },
    );

    expect(exitCode).toBe(CliExitCode.Interrupted);
    expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
    expect(
      cliLogSinksMock.writeTextStderrAndWait,
    ).toHaveBeenCalledExactlyOnceWith(
      expectedRecoveryHint(context, 'exec-signal', persistedWorkspace),
    );
  });

  it('prints recovery when the original process directory is unavailable', async () => {
    const run = workflowRun('exec-deleted-cwd', {
      outcome: RUN_OUTCOME.CANCELLED,
    });
    mockWorkflowRun(run, true);
    const stableWorkspace = path.join(path.sep, 'tmp', 'stable-workspace');
    const context = createRunCommandCliContext({ cwd: stableWorkspace });
    const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('launch directory was deleted');
    });
    const { executeCliWorkflowConfig: nativeExecute } =
      await import('@cli/commands/workflow');
    const executeCliWorkflowConfig = (
      ...args: Parameters<typeof nativeExecute>
    ) => Effect.runPromise(nativeExecute(...args));

    const result = executeCliWorkflowConfig(
      {
        agent: 'polish',
        model: 'deepseekT',
        workingDirectory: stableWorkspace,
        agentCategory: AgentCategory.Workflow,
      },
      context,
      { categoryMismatchMessage: 'unexpected category' },
    );
    await expect(result).resolves.toBe(CliExitCode.Interrupted);
    expect(cwdSpy).toHaveBeenCalledOnce();
    cwdSpy.mockRestore();
    expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledExactlyOnceWith(
      `Resume this workflow with: ${formatResumeCommand(
        context.commandName,
        'exec-deleted-cwd',
        {
          cwd: stableWorkspace,
          processCwd: undefined,
          approvalPolicy: context.approvalPolicy,
          outputFormat: context.outputFormat,
          print: true,
        },
      )}`,
    );
  });

  it('does not print a recovery command for completed workflows', async () => {
    const exitCode = await runWorkflow();

    expect(exitCode).toBe(CliExitCode.Success);
    expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
    expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalled();
  });

  it.each(['json', 'ndjson'] as const)(
    'keeps %s stdout free of the cancellation recovery hint',
    async (outputFormat) => {
      mockWorkflowRun(
        workflowRun('exec-interrupted', {
          outcome: RUN_OUTCOME.CANCELLED,
        }),
        true,
      );

      const exitCode = await runWorkflow(
        {},
        createRunCommandCliContext({ outputFormat }),
      );

      expect(exitCode).toBe(CliExitCode.Interrupted);
      expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
      expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledExactlyOnceWith(
        expectedRecoveryHint(
          createRunCommandCliContext({ outputFormat }),
          'exec-interrupted',
        ),
      );
    },
  );

  it('does not print a recovery command for failed workflows', async () => {
    mockWorkflowRun(
      workflowRun('exec-failed', { outcome: RUN_OUTCOME.FAILED }),
      true,
    );

    const exitCode = await runWorkflow();

    expect(exitCode).toBe(CliExitCode.AgentError);
    expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
    expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalled();
  });

  it('reports missing instruction files before starting platform or input work', async () => {
    await expect(
      runWorkflow({ instructionFile: 'missing-prompt.md' }),
    ).rejects.toThrow(/--instruction-file: file not found: missing-prompt\.md/);

    expect(cliInitPlatformMock.initLocalCliPlatform).not.toHaveBeenCalled();
    expect(mocks.resolveCliLaunchAgent).not.toHaveBeenCalled();
    expectNoModelOrInputWork();
  });
});
