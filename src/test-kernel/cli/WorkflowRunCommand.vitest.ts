/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Shared mock registrations must evaluate before anything that loads
// the mocked modules — keep these imports immediately after the vitest
// import (enforced by architecture/supportMockImportOrder.vitest.ts).
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { cliLogSinksMock } from '@test/support/cliLogSinksMock';

import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Result } from 'effect';
import type { SessionHandle } from '@agent/runtime';
import { getRunRecords } from '@agent/storage';
import { DatabaseWriteFailed } from '@shared/session/database';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { runHeadlessAgent } from '@cli/commands/workflow';
import { formatResumeCommand } from '@cli/chat/tui/state/resumeHint';
import type { CliContext } from '@cli/runtime/cliContext';
import type {
  CliConfigExecuteOptions,
  CliConfigExecuteResult,
} from '@cli/runtime/executeCli';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { testRuntime } from '@test/support/testProcessRuntime';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import {
  aggregateId,
  RUN_OUTCOME,
  type FlowSnapshotPayload,
  type RunId,
  type SessionEventDraft,
  AgentCategory,
} from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { createRunCommandCliContext } from '@test/cli/fixtures/cliContext';
import {
  fakeProcessServices,
  installedHost,
} from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';
import { withTempDirEffect } from '@test/support/tempDirPlatform';

const mocks = vi.hoisted(() => {
  return {
    executeCliConfig: vi.fn(),
    emitCliResult: vi.fn(),
    withExpandedRunInputs: vi.fn(),
    resolveCliRunAgent: vi.fn(),
    selectCliRunModel: vi.fn(),
  };
});

vi.mock('@utils/files/runStorageFs', async (importActual) => ({
  ...(await importActual<typeof import('@utils/files/runStorageFs')>()),
  runDirUnder: vi.fn(
    (_storageRoot: string, runId: string) => `/tmp/runs/${runId}`,
  ),
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
  resolveCliRunAgent: mocks.resolveCliRunAgent,
}));

vi.mock('@cli/runtime/executeCli', () => ({
  // A pass-through, so the mocked seam has the real module's Effect-returning
  // shape and every stub below returns the program the command yields.
  executeCliConfig: (...args: unknown[]) => mocks.executeCliConfig(...args),
}));

vi.mock('@cli/runtime/workflowInputs', () => ({
  // A pass-through: the real helper yields `run(inputs)` in-fiber, so the stub
  // hands the command back that same Effect instead of detaching it.
  withExpandedRunInputs: (...args: unknown[]) =>
    mocks.withExpandedRunInputs(...args),
  hasMixedStdinWorkflowInputSpecs: vi.fn((inputFiles: readonly string[]) => {
    const specs = new Set(
      inputFiles.map((spec) => spec.trim()).filter(Boolean),
    );
    return specs.has('-') && specs.size > 1;
  }),
  STDIN_WORKFLOW_INPUT_BASENAME: 'stdin.tex',
  WORKFLOW_INPUT_REQUIRED_MESSAGE:
    'At least one workflow input file is required.',
}));

// Hoisted out of each test body — a dynamic import()'s result is cached, so
// one call here serves every test below, and the first test is not charged the
// module graph's transform time.
const { runHeadlessAgent: nativeRun } = await import('@cli/commands/workflow');

type WorkflowRunInit = Parameters<typeof runHeadlessAgent>[1];
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

/** The session the suite's init installs, as the command resolved it. */
let fixtureSession: SessionHandle | undefined;

function currentSession(): SessionHandle {
  if (!fixtureSession) throw new Error('No fixture session installed.');
  return fixtureSession;
}

/**
 * Run ids the mocked launch has reported, waiting for the opening row its
 * real counterpart would have committed; and the ones already opened this
 * test, so an explicit seed and the program's seed never double one.
 */
let pendingRunStarts: string[] = [];
const seededRunIds = new Set<string>();

/** The workflow command's program over the shared happy-path inputs. */
function workflowProgram(
  init: Partial<WorkflowRunInit> = {},
  context: CliContext = createRunCommandCliContext(),
): Effect.Effect<number, Error> {
  // The mocked launch boundary skips the launch's own `run.start` commit, so
  // the fixture session opens the run the mock reports first: an aggregate's
  // first row must be that start, and the claim it takes is the one the
  // finalization write below commits against.
  const starts = pendingRunStarts;
  pendingRunStarts = [];
  return Effect.gen(function* () {
    yield* Effect.forEach(
      starts,
      (runId) => seedStartedRun(currentSession(), runId),
      { discard: true },
    );
    return yield* Effect.provide(
      nativeRun(context, {
        agent: 'polish',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        instruction: '',
        ...init,
      }),
      fakeProcessServices(),
    );
  });
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
    Pick<WorkflowRunPayload, 'outcome'> &
      Pick<WorkflowRunPayload['output'], 'outputs' | 'compileFailures'>
  > = {},
): WorkflowExecuteResult {
  const { outcome = RUN_OUTCOME.COMPLETED, ...output } = overrides;
  return {
    ok: true,
    runId,
    outcomePersisted: true,
    result: {
      outcome,
      output: {
        category: AgentCategory.Workflow,
        outputs: [],
        compileFailures: [],
        diffs: [],
        ...output,
      },
      runId: runId as RunId,
    },
  };
}

function mockWorkflowRun(
  result: WorkflowExecuteResult,
  once = false,
  /** What the launch loaded off the agent's definition, as the run hands it on. */
  agentDefaultOutputFiles: readonly string[] = [],
): void {
  const implementation = (
    _config: unknown,
    _context: unknown,
    options: {
      readonly openWorkflowOutput?: CliConfigExecuteOptions['openWorkflowOutput'];
    },
  ) =>
    Effect.gen(function* () {
      if (result.ok && options.openWorkflowOutput) {
        const outputOutcome = yield* options.openWorkflowOutput(
          result.result,
          agentDefaultOutputFiles,
          () => true,
        );
        if (outputOutcome !== undefined) {
          return {
            ...result,
            result: { ...result.result, outcome: outputOutcome },
          };
        }
      }
      return result;
    });
  if (result.ok) pendingRunStarts.push(result.result.runId);
  if (once) mocks.executeCliConfig.mockImplementationOnce(implementation);
  else mocks.executeCliConfig.mockImplementation(implementation);
}

/** Mocks a run whose cancellation lands during output finalization. */
function mockCancellationDuringOutputFinalization(
  provisional: WorkflowExecuteResult,
  tryCommitPublication: () => boolean,
): void {
  if (!provisional.ok) throw new Error('Expected a workflow result.');
  pendingRunStarts.push(provisional.result.runId);
  mocks.executeCliConfig.mockImplementationOnce(
    (
      _config: unknown,
      _context: unknown,
      options: {
        readonly openWorkflowOutput?: CliConfigExecuteOptions['openWorkflowOutput'];
      },
    ) =>
      Effect.gen(function* () {
        if (options.openWorkflowOutput)
          yield* options.openWorkflowOutput(
            provisional.result,
            [],
            tryCommitPublication,
          );
        return {
          ...provisional,
          result: {
            ...provisional.result,
            outcome: RUN_OUTCOME.CANCELLED,
          },
        };
      }),
  );
}

/**
 * The result envelope the command persists for history details. How the run
 * ended is the `run.end` row's fact, so the record carries only its output.
 */
function expectedResultMeta(options: {
  readonly outputs: readonly unknown[];
  readonly compileFailures: readonly unknown[];
  readonly copiedOutput?: string;
  readonly copiedOutputs?: readonly string[];
}): Record<string, unknown> {
  const { outputs, compileFailures, ...copies } = options;
  return {
    producer: 'cliWorkflow',
    ...copies,
    output: {
      category: 'workflow',
      outputs,
      compileFailures,
      diffs: [],
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

type ReflectionState = Extract<
  FlowSnapshotPayload,
  { family: 'reflection' }
>['state'];

/** The reflection snapshot a round writes, minus the fields a case sets. */
function reflectionSnapshot(
  state: Partial<ReflectionState> = {},
  runtime: Partial<FlowSnapshotPayload['runtime']> = {},
): FlowSnapshotPayload {
  return {
    family: 'reflection',
    runtime: {
      phase: 'initial',
      round: 0,
      turn: 0,
      continuationIndex: 0,
      modelId: 'deepseekT',
      modelCompatibilityKey: null,
      lastError: null,
      declinedRoutes: [],
      ...runtime,
    },
    state: {
      totalRounds: 4,
      workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
      ...state,
    },
  };
}

/** The metadata the command last persisted for a run, read back for real. */
const readResultMeta = (session: SessionHandle, runId: string) =>
  getRunRecords(session, runId as RunId).readResultMeta();

/**
 * The run's opening row, committed by the fixture session itself: the first
 * append claims the aggregate for this process, the way the launch's own
 * commit claims it before finalization writes.
 */
const seedStartedRun = (session: SessionHandle, runId: string) =>
  Effect.gen(function* () {
    if (seededRunIds.has(runId)) return;
    yield* session.commit([
      {
        type: 'run.start',
        aggregateId: aggregateId('run', runId as RunId),
        identity: { kind: 'agent', agent: 'polish' },
        category: AgentCategory.Workflow,
        userFollowUpSupport: 'unsupported',
        isRemote: false,
        parent: null,
      },
    ]);
    seededRunIds.add(runId);
  });

/**
 * The checkpoint the recovery hint reads. The claim stays with the fixture
 * session: a run being finalized is one its process still holds, and the
 * metadata write below it commits against that same claim.
 */
const seedResumableCheckpoint = (session: SessionHandle, runId: string) =>
  Effect.gen(function* () {
    yield* seedStartedRun(session, runId);
    yield* session.ledger.acquire(runId as RunId);
    yield* session.ledger.appendBatch(runId as RunId, null, [
      {
        type: 'flow.snapshot',
        aggregateId: aggregateId('run', runId as RunId),
        payload: reflectionSnapshot(),
      },
    ]);
  });

/** The commit the command's result-metadata write makes, for ordering. */
const resultMetaCommitOrder = (commitSpy: {
  readonly mock: {
    readonly calls: readonly (readonly [readonly SessionEventDraft[]])[];
    readonly invocationCallOrder: readonly number[];
  };
}): number => {
  const index = commitSpy.mock.calls.findIndex(([drafts]) =>
    drafts.some((draft) => draft.type === 'run.result'),
  );
  if (index < 0) throw new Error('The run.result commit never happened.');
  const order = commitSpy.mock.invocationCallOrder[index];
  if (order === undefined)
    throw new Error('The run.result commit never happened.');
  return order;
};

function expectNoModelOrInputWork(): void {
  expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
  expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
}

describe('CLI run command, workflow agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingRunStarts = [];
    seededRunIds.clear();
    // The CLI init hands its caller the platform's stores; the commands
    // under test read `secrets`/`globalState` off what it returns.
    const session = createTestSession();
    fixtureSession = session;
    const platform = {
      ...installedHost().platform,
      session: Effect.succeed(session),
      runtime: testRuntime(),
    };
    cliInitPlatformMock.initCliPlatform.mockReturnValue(
      Effect.succeed(platform),
    );
    mocks.resolveCliRunAgent.mockReturnValue(
      Effect.succeed({
        name: 'polish',
        category: AgentCategory.Workflow,
        source: 'builtInWorkflow',
        path: '/agents/polish.yaml',
        tools: [],
      }),
    );
    mocks.selectCliRunModel.mockImplementation(
      (_context: CliContext, model: string | undefined) =>
        Effect.succeed(model ?? 'deepseekT'),
    );
    mocks.withExpandedRunInputs.mockImplementation(
      (
        _inputSpecs: readonly string[],
        _contextSpecs: readonly string[],
        _cwd: string,
        _options: unknown,
        run: (inputs: {
          readonly inputFiles: string[];
          readonly contextFiles: string[];
          readonly stdinInputPath?: string;
        }) => Effect.Effect<unknown, unknown, never>,
      ) => run({ inputFiles: ['paper.tex'], contextFiles: [] }),
    );
  });

  afterEach(async () => {
    if (fixtureSession) await Effect.runPromise(closeSessionOf(fixtureSession));
    fixtureSession = undefined;
  });

  it.effect(
    'reports conflicting output targets before platform or model lookup',
    () =>
      Effect.gen(function* () {
        // The usage error is raised by a bare `throw` inside the command's
        // generator, so it arrives as a defect, not a typed failure.
        const exit = yield* Effect.exit(
          workflowProgram({ output: 'out.tex', outputDir: 'out' }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const defect = Exit.isFailure(exit)
          ? Cause.squash(exit.cause)
          : undefined;
        expect(defect).toBeInstanceOf(Error);
        expect((defect as Error).message).toContain(
          'Use either --output or --output-dir, not both.',
        );

        expect(cliInitPlatformMock.initCliPlatform).not.toHaveBeenCalled();
        expect(mocks.resolveCliRunAgent).not.toHaveBeenCalled();
        expectNoModelOrInputWork();
      }),
  );

  it.effect(
    'reports single-output mixed stdin usage before resolving the model',
    () =>
      Effect.gen(function* () {
        // Same bare `throw` as above: a defect, not a typed failure.
        const exit = yield* Effect.exit(
          workflowProgram({
            inputFiles: ['-', 'paper.tex'],
            output: 'out.tex',
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const defect = Exit.isFailure(exit)
          ? Cause.squash(exit.cause)
          : undefined;
        expect(defect).toBeInstanceOf(Error);
        expect((defect as Error).message).toContain(
          'Use --output-dir for multi-input workflow runs; --output is only for a single final artifact.',
        );

        expect(cliInitPlatformMock.initCliPlatform).toHaveBeenCalled();
        expect(mocks.resolveCliRunAgent).toHaveBeenCalledWith(
          expect.anything(),
          'polish',
        );
        expectNoModelOrInputWork();
      }),
  );

  // The output probes `mkdir -p` their destination, so a run that can never
  // start has to be refused before them — otherwise an invalid command leaves
  // directories behind.
  it.effect(
    'refuses a workflow run with no input before creating the output directory',
    () =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            workflowProgram(
              {
                inputFiles: [],
                instruction: 'Polish it.',
                outputDir: path.join(root, 'missing', 'out'),
              },
              createRunCommandCliContext({ cwd: root }),
            ),
          );

          // The command fails with the typed `CliUsageError`.
          expect(Exit.isFailure(exit)).toBe(true);
          expect(
            Exit.isFailure(exit) &&
              exit.cause.reasons.find(Cause.isFailReason)?.error,
          ).toMatchObject({
            message: 'At least one workflow input file is required.',
          });
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                Effect.tryPromise(() => fs.stat(path.join(root, 'missing'))),
              ),
            ),
          ).toBe(true);
          expectNoModelOrInputWork();
        }),
      ),
  );

  it.effect(
    'passes instruction file contents before inline workflow instructions',
    () =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(root, 'prompt.md'),
              'Read this prompt from disk.\n',
            ),
          );
          mockWorkflowRun(workflowRun('abc001'));

          const exitCode = yield* workflowProgram(
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
        }),
      ),
  );

  it.effect('enforces workflow results at the shared run boundary', () =>
    Effect.gen(function* () {
      mockWorkflowRun(workflowRun('abc001'));

      const exitCode = yield* workflowProgram();

      expect(exitCode).toBe(0);
      expect(mocks.executeCliConfig.mock.calls[0]?.[2]).toMatchObject({
        expectedCategory: AgentCategory.Workflow,
      });
    }),
  );

  it.effect(
    'keeps the single-output copy target separate from workflow output names',
    () =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          const generated = yield* Effect.promise(() =>
            writeGeneratedOutput(root),
          );
          const outputSummary = runOutputSummary(
            generated,
            path.join(root, 'paper.tex'),
          );
          const compileFailure = {
            round: 1,
            displayName: 'paper.tex',
            outputPath: 'r1/paper.tex',
            logPath: 'compile/r1_paper.tex.log',
            logAbsolutePath: path.join(
              root,
              'run',
              'compile',
              'r1_paper.tex.log',
            ),
          };
          mockWorkflowRun(
            workflowRun('abc002', {
              outputs: [outputSummary],
              compileFailures: [compileFailure],
            }),
            true,
          );

          const exitCode = yield* workflowProgram(
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
          expect(
            yield* Effect.promise(() =>
              fs.readFile(path.join(root, 'polished.tex'), 'utf8'),
            ),
          ).toBe('polished');
          expect(
            yield* readResultMeta(currentSession(), 'abc002'),
          ).toMatchObject(
            expectedResultMeta({
              copiedOutput: path.join(root, 'polished.tex'),
              outputs: [outputSummary],
              compileFailures: [compileFailure],
            }),
          );
          const emission = mocks.emitCliResult.mock.calls[0]?.[1];
          expect(emission?.json).toMatchObject({
            outcome: RUN_OUTCOME.COMPLETED,
            workingDirectory: root,
            runDirectory: '/tmp/runs/abc002',
            copiedOutput: path.join(root, 'polished.tex'),
          });
          // The emitted object is the run result plus its filesystem metadata, in
          // the order `resolveWorkflowOutput` builds it; the run id is `runId`.
          expect(Object.keys(emission?.json ?? {})).toEqual([
            'outcome',
            'output',
            'runId',
            'workingDirectory',
            'runDirectory',
            'copiedOutput',
          ]);
          expect(emission?.ndjson).toEqual({
            kind: 'result',
            result: emission.json,
          });
        }),
      ),
  );

  it.effect('persists copied output-dir paths for history details', () =>
    withTempDirEffect('texra-workflow-', (root) =>
      Effect.gen(function* () {
        const workspace = path.join(root, 'workspace ');
        const generated = yield* Effect.promise(() =>
          writeGeneratedOutput(workspace),
        );
        const outputSummary = runOutputSummary(
          generated,
          path.join(workspace, 'paper.tex'),
        );
        mockWorkflowRun(
          workflowRun('abc003', { outputs: [outputSummary] }),
          true,
        );

        const exitCode = yield* workflowProgram(
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
        expect(
          yield* Effect.promise(() =>
            fs.readFile(path.join(workspace, 'out', 'paper.tex'), 'utf8'),
          ),
        ).toBe('polished');
        expect(yield* readResultMeta(currentSession(), 'abc003')).toMatchObject(
          expectedResultMeta({
            copiedOutputs: [path.join(workspace, 'out', 'paper.tex')],
            outputs: [outputSummary],
            compileFailures: [],
          }),
        );
      }),
    ),
  );

  // Issue #12162: a remote agent's catalog listing carries no
  // `defaultOutputFiles`, so only the definition the launch loads declares
  // them — and the launch hands them to output finalization, as the stub
  // here does: the declared name still decides.
  it.effect('expects the output files the launched definition declares', () =>
    withTempDirEffect('texra-workflow-', (root) =>
      Effect.gen(function* () {
        const generated = yield* Effect.promise(() =>
          writeGeneratedOutput(root),
        );
        mockWorkflowRun(
          workflowRun('abc004', {
            outputs: [
              runOutputSummary(generated, path.join(root, 'paper.tex')),
            ],
          }),
          true,
          ['slides.tex'],
        );

        const exitCode = yield* workflowProgram(
          { outputDir: 'out' },
          createRunCommandCliContext({ cwd: root }),
        );

        expect(exitCode).toBe(CliExitCode.AgentError);
        // The launch persisted only the input-derived names; the declared
        // `slides.tex` is what the copy is held to.
        expect(mocks.executeCliConfig.mock.calls[0]?.[0]).toMatchObject({
          cli: { expectedOutputFiles: ['paper.tex'] },
        });
        expect(cliLogSinksMock.writeErrorStderr).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining('slides.tex'),
          }),
        );
      }),
    ),
  );

  // it.live: the body drives a real session through the process runtime.
  it.live('persists workflow metadata before the run claim is released', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { createTestSession } = yield* Effect.promise(
          () => import('@test/support/sessionTestUtils'),
        );
        const session = yield* Effect.acquireRelease(
          Effect.sync(() => createTestSession()),
          (owned) => closeSessionOf(owned),
        );
        const runId = 'abc123abc123' as RunId;
        const run = workflowRun(runId);
        if (!run.ok) throw new Error('Expected workflow result.');
        // The command reads the session off the services its init returns.
        cliInitPlatformMock.initCliPlatform.mockReturnValueOnce(
          Effect.succeed({
            ...installedHost().platform,
            session: Effect.succeed(session),
          }),
        );
        const records = getRunRecords(session, runId);
        // The run's first append claims its aggregate for this process; the
        // release below is what makes a later write refuse.
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
        // The executeCliConfig stub is an Effect port. Its run owns output
        // finalization and releases the real claim before returning.
        mocks.executeCliConfig.mockImplementationOnce(
          (_config, _context, options) =>
            options
              .openWorkflowOutput(run.result, [], () => true)
              .pipe(
                Effect.as(run),
                Effect.ensuring(
                  session.releaseRunLease(runId).pipe(Effect.orDie),
                ),
              ),
        );
        expect(yield* workflowProgram({}, createRunCommandCliContext())).toBe(
          0,
        );
        expect(yield* records.readResultMeta()).toMatchObject({
          producer: 'cliWorkflow',
          output: { category: 'workflow' },
        });
        const afterRelease = yield* Effect.result(
          records.writeResultMeta({
            producer: 'cliWorkflow',
            output: run.result.output,
          }),
        );
        expect(Result.isFailure(afterRelease)).toBe(true);
      }),
    ),
  );

  it.effect(
    'reports failure when completed workflow metadata cannot be persisted',
    () =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          const generated = yield* Effect.promise(() =>
            writeGeneratedOutput(root),
          );
          mockWorkflowRun(
            workflowRun('abc005', {
              outputs: [
                runOutputSummary(generated, path.join(root, 'paper.tex')),
              ],
            }),
            true,
          );
          // The run's opening row commits before the spy installs, so the one
          // commit the spy fails is the metadata write itself — the record
          // store's own DatabaseWriteFailed, carried out on the typed Error
          // channel, unlike the usage errors above.
          yield* seedStartedRun(currentSession(), 'abc005');
          vi.spyOn(currentSession(), 'commit').mockReturnValueOnce(
            Effect.fail(
              new DatabaseWriteFailed({
                path: 'run-records',
                cause: new Error('metadata disk full'),
              }),
            ),
          );

          const error = yield* Effect.flip(
            workflowProgram(
              { outputDir: 'out' },
              createRunCommandCliContext({ cwd: root }),
            ),
          );
          expect(toErrorMessage(error.cause)).toContain('metadata disk full');

          expect(
            yield* Effect.promise(() =>
              fs.readFile(path.join(root, 'out', 'paper.tex'), 'utf8'),
            ),
          ).toBe('polished');
          expect(mocks.emitCliResult).not.toHaveBeenCalled();
        }),
      ),
  );

  it.effect(
    'persists a failed runtime envelope when copying the requested output fails',
    () =>
      Effect.gen(function* () {
        const outputSummary = runOutputSummary(
          '/missing/run/r1/paper.tex',
          '/workspace/paper.tex',
        );
        mockWorkflowRun(
          workflowRun('abc006', { outputs: [outputSummary] }),
          true,
        );

        const exitCode = yield* workflowProgram({ output: 'polished.tex' });

        expect(exitCode).toBe(CliExitCode.AgentError);
        expect(yield* readResultMeta(currentSession(), 'abc006')).toMatchObject(
          expectedResultMeta({
            outputs: [outputSummary],
            compileFailures: [],
          }),
        );
      }),
  );

  it.effect(
    'prints a resumable recovery command after persisting a cancelled workflow',
    () =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          mockWorkflowRun(
            workflowRun('abc007', {
              outcome: RUN_OUTCOME.CANCELLED,
            }),
            true,
          );
          // The hint advertises only a resumable run: the cancelled run's own
          // checkpoint is what the real resumability read has to find.
          yield* seedResumableCheckpoint(currentSession(), 'abc007');
          const commitSpy = vi.spyOn(currentSession(), 'commit');

          const context = createRunCommandCliContext({
            cwd: root,
            commandName: 'texra-local',
            approvalPolicy: 'never',
          });
          const exitCode = yield* workflowProgram(
            { output: 'polished.tex' },
            context,
          );

          expect(exitCode).toBe(CliExitCode.Interrupted);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                Effect.tryPromise(() =>
                  fs.stat(path.join(root, 'polished.tex')),
                ),
              ),
            ),
          ).toBe(true);
          expect(
            yield* readResultMeta(currentSession(), 'abc007'),
          ).toMatchObject(
            expectedResultMeta({
              outputs: [],
              compileFailures: [],
            }),
          );
          expect(
            cliLogSinksMock.writeTextStderr,
          ).toHaveBeenCalledExactlyOnceWith(
            expectedRecoveryHint(context, 'abc007'),
          );
          expect(resultMetaCommitOrder(commitSpy)).toBeLessThan(
            cliLogSinksMock.writeTextStderr.mock.invocationCallOrder[0]!,
          );
        }),
      ),
  );

  it.effect(
    'keeps non-empty cancelled outputs in run storage without copying to --output',
    () =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          const outputSummary = yield* Effect.promise(() =>
            setupCancelledOutput(root, 'abc008'),
          );
          yield* seedResumableCheckpoint(currentSession(), 'abc008');

          const context = createRunCommandCliContext({
            cwd: root,
            commandName: 'texra-local',
            approvalPolicy: 'never',
          });
          const exitCode = yield* workflowProgram(
            { output: 'polished.tex' },
            context,
          );

          expect(exitCode).toBe(CliExitCode.Interrupted);
          // The destination did not previously exist and must stay absent.
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                Effect.tryPromise(() =>
                  fs.stat(path.join(root, 'polished.tex')),
                ),
              ),
            ),
          ).toBe(true);
          expect(
            yield* readResultMeta(currentSession(), 'abc008'),
          ).toMatchObject(
            expectedResultMeta({
              outputs: [outputSummary],
              compileFailures: [],
            }),
          );
          const emission = mocks.emitCliResult.mock.calls[0]?.[1];
          expect(emission?.json).toMatchObject({
            outcome: RUN_OUTCOME.CANCELLED,
            workingDirectory: root,
            runDirectory: '/tmp/runs/abc008',
          });
          expect(emission?.json).not.toHaveProperty('copiedOutput');
          expect(emission?.json).not.toHaveProperty('copiedOutputs');
          expect(emission?.text).toBe('/tmp/runs/abc008');
          expect(
            cliLogSinksMock.writeTextStderr,
          ).toHaveBeenCalledExactlyOnceWith(
            expectedRecoveryHint(context, 'abc008'),
          );
        }),
      ),
  );

  it.effect(
    'keeps non-empty cancelled outputs in run storage without copying to --output-dir',
    () =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          const outputSummary = yield* Effect.promise(() =>
            setupCancelledOutput(root, 'abc009'),
          );
          yield* seedResumableCheckpoint(currentSession(), 'abc009');

          const context = createRunCommandCliContext({
            cwd: root,
            commandName: 'texra-local',
            approvalPolicy: 'never',
          });
          const exitCode = yield* workflowProgram(
            { outputDir: 'out' },
            context,
          );

          expect(exitCode).toBe(CliExitCode.Interrupted);
          // The pre-flight probe may create the directory itself, but no output
          // file may be copied into it.
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                Effect.tryPromise(() =>
                  fs.stat(path.join(root, 'out', 'paper.tex')),
                ),
              ),
            ),
          ).toBe(true);
          expect(
            yield* readResultMeta(currentSession(), 'abc009'),
          ).toMatchObject(
            expectedResultMeta({
              outputs: [outputSummary],
              compileFailures: [],
            }),
          );
          const emission = mocks.emitCliResult.mock.calls[0]?.[1];
          expect(emission?.json).toMatchObject({
            outcome: RUN_OUTCOME.CANCELLED,
            workingDirectory: root,
            runDirectory: '/tmp/runs/abc009',
          });
          expect(emission?.json).not.toHaveProperty('copiedOutput');
          expect(emission?.json).not.toHaveProperty('copiedOutputs');
          expect(emission?.text).toBe('/tmp/runs/abc009');
          expect(
            cliLogSinksMock.writeTextStderr,
          ).toHaveBeenCalledExactlyOnceWith(
            expectedRecoveryHint(context, 'abc009'),
          );
        }),
      ),
  );

  it.effect.each([
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
    ({ init, destination }) =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          const generated = yield* Effect.promise(() =>
            writeGeneratedOutput(root),
          );
          const outputSummary = runOutputSummary(
            generated,
            path.join(root, 'paper.tex'),
          );
          mockWorkflowRun(
            workflowRun('abc00a', {
              outcome: RUN_OUTCOME.FAILED,
              outputs: [outputSummary],
            }),
            true,
          );
          const target = destination(root);
          yield* Effect.promise(() =>
            fs.mkdir(path.dirname(target), { recursive: true }),
          );
          yield* Effect.promise(() => fs.writeFile(target, 'keep-me'));

          const exitCode = yield* workflowProgram(
            init,
            createRunCommandCliContext({ cwd: root }),
          );

          expect(exitCode).toBe(CliExitCode.AgentError);
          expect(yield* Effect.promise(() => fs.readFile(target, 'utf8'))).toBe(
            'keep-me',
          );
          const emission = mocks.emitCliResult.mock.calls[0]?.[1];
          expect(emission?.json).toMatchObject({
            outcome: RUN_OUTCOME.FAILED,
            output: { outputs: [outputSummary] },
            runDirectory: '/tmp/runs/abc00a',
          });
          expect(emission?.json).not.toHaveProperty('copiedOutput');
          expect(emission?.json).not.toHaveProperty('copiedOutputs');
          expect(emission?.text).toContain('FAILED');
          expect(emission?.text).toContain('/tmp/runs/abc00a');
        }),
      ),
  );

  it.effect(
    'leaves a pre-existing --output destination untouched for a cancelled run',
    () =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          const destination = path.join(root, 'polished.tex');
          yield* Effect.promise(() => fs.writeFile(destination, 'keep-me'));
          yield* Effect.promise(() => setupCancelledOutput(root, 'abc00b'));

          const exitCode = yield* workflowProgram(
            { output: 'polished.tex' },
            createRunCommandCliContext({ cwd: root }),
          );

          expect(exitCode).toBe(CliExitCode.Interrupted);
          expect(
            yield* Effect.promise(() => fs.readFile(destination, 'utf8')),
          ).toBe('keep-me');
        }),
      ),
  );

  it.effect(
    'presents the lifecycle verdict when cancellation lands during output finalization',
    () =>
      Effect.gen(function* () {
        mockCancellationDuringOutputFinalization(
          workflowRun('abc00c'),
          () => true,
        );

        const exitCode = yield* workflowProgram();

        expect(exitCode).toBe(CliExitCode.Interrupted);
        expect(yield* readResultMeta(currentSession(), 'abc00c')).toMatchObject(
          expectedResultMeta({
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
      }),
  );

  it.effect.each([
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
    ({ init, destination, existing }) =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          const generated = yield* Effect.promise(() =>
            writeGeneratedOutput(root),
          );
          const outputSummary = runOutputSummary(
            generated,
            path.join(root, 'paper.tex'),
          );
          mockCancellationDuringOutputFinalization(
            workflowRun('abc00c', {
              outputs: [outputSummary],
            }),
            () => false,
          );
          const target = destination(root);
          if (existing) {
            yield* Effect.promise(() =>
              fs.mkdir(path.dirname(target), { recursive: true }),
            );
            yield* Effect.promise(() => fs.writeFile(target, 'existing'));
          }

          const exitCode = yield* workflowProgram(
            init,
            createRunCommandCliContext({ cwd: root }),
          );

          expect(exitCode).toBe(CliExitCode.Interrupted);
          if (existing) {
            expect(
              yield* Effect.promise(() => fs.readFile(target, 'utf8')),
            ).toBe('existing');
          } else {
            expect(
              Exit.isFailure(
                yield* Effect.exit(Effect.tryPromise(() => fs.stat(target))),
              ),
            ).toBe(true);
          }
          expect(
            yield* readResultMeta(currentSession(), 'abc00c'),
          ).toMatchObject(
            expectedResultMeta({
              outputs: [outputSummary],
              compileFailures: [],
            }),
          );
          const emitted = mocks.emitCliResult.mock.calls[0]?.[1]?.json;
          expect(emitted).toMatchObject({
            outcome: RUN_OUTCOME.CANCELLED,
            runDirectory: '/tmp/runs/abc00c',
          });
          expect(emitted).not.toHaveProperty('copiedOutput');
          expect(emitted).not.toHaveProperty('copiedOutputs');
        }),
      ),
  );

  it.effect(
    'does not advertise resume when cancelled status is not durable',
    () =>
      Effect.gen(function* () {
        const durableRun = workflowRun('abc00d', {
          outcome: RUN_OUTCOME.CANCELLED,
        });
        if (!durableRun.ok) throw new Error('Expected a workflow result.');
        mockWorkflowRun({ ...durableRun, outcomePersisted: false }, true);

        expect(yield* workflowProgram()).toBe(CliExitCode.Interrupted);

        expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
        expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalled();
      }),
  );

  it.effect('does not advertise resume for temporary materialized stdin', () =>
    Effect.gen(function* () {
      const root = path.join(path.sep, 'tmp', 'workspace');
      const stdinPath = path.join(root, 'texra-stdin-123-abc123', 'stdin.tex');
      mocks.withExpandedRunInputs.mockImplementationOnce(
        (_inputs, _contexts, _cwd, _options, run) =>
          run({
            inputFiles: [stdinPath],
            contextFiles: [],
            stdinInputPath: stdinPath,
          }),
      );
      mockWorkflowRun(
        workflowRun('abc00e', {
          outcome: RUN_OUTCOME.CANCELLED,
        }),
        true,
      );

      expect(
        yield* workflowProgram(
          { inputFiles: ['-'] },
          createRunCommandCliContext({ cwd: root }),
        ),
      ).toBe(CliExitCode.Interrupted);

      expect(
        mocks.executeCliConfig.mock.calls[0]?.[2].onInterruptedRunFinalized,
      ).toBeUndefined();
      expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
      expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'keeps recovery for a durable file whose name resembles stdin materialization',
    () =>
      Effect.gen(function* () {
        const lookalike = path.join(
          path.sep,
          'tmp',
          'workspace',
          'texra-stdin-123-abc123',
          'stdin.tex',
        );
        mocks.withExpandedRunInputs.mockImplementationOnce(
          (_inputs, _contexts, _cwd, _options, run) =>
            run({ inputFiles: [lookalike], contextFiles: [] }),
        );
        mockWorkflowRun(
          workflowRun('abc00f', {
            outcome: RUN_OUTCOME.CANCELLED,
          }),
          true,
        );
        // The hint advertises only a resumable run, so the cancelled run's own
        // checkpoint is what the real resumability read has to find.
        yield* seedResumableCheckpoint(currentSession(), 'abc00f');

        expect(yield* workflowProgram()).toBe(CliExitCode.Interrupted);

        expect(
          mocks.executeCliConfig.mock.calls[0]?.[2].onInterruptedRunFinalized,
        ).toBeTypeOf('function');
        expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledOnce();
      }),
  );

  it.effect(
    'rejects recovery advertising for a snapshot carrying a round failure',
    () =>
      Effect.gen(function* () {
        mockWorkflowRun(workflowRun('abc001'));

        yield* workflowProgram();
        const canAdvertise =
          mocks.executeCliConfig.mock.calls[0]?.[2].canAdvertiseInterruptedRun;

        expect(
          canAdvertise?.({
            kind: 'checkpoint',
            snapshot: reflectionSnapshot(
              {},
              {
                lastError: { message: 'provider failed', userRetryable: true },
              },
            ),
          }),
        ).toBe(false);
      }),
  );

  it.effect(
    'rejects recovery advertising for terminal unresolved compile rejection',
    () =>
      Effect.gen(function* () {
        mockWorkflowRun(workflowRun('abc001'));

        yield* workflowProgram();
        const canAdvertise =
          mocks.executeCliConfig.mock.calls[0]?.[2].canAdvertiseInterruptedRun;

        expect(
          canAdvertise?.({
            kind: 'checkpoint',
            snapshot: reflectionSnapshot(
              { totalRounds: 2, unresolvedCompileRejection: true },
              { round: 1 },
            ),
          }),
        ).toBe(false);
        expect(
          canAdvertise?.({
            kind: 'checkpoint',
            snapshot: reflectionSnapshot({
              totalRounds: 2,
              unresolvedCompileRejection: true,
            }),
          }),
        ).toBe(true);
      }),
  );

  it.effect(
    'prints the durable shutdown hint once with the persisted workspace',
    () =>
      Effect.gen(function* () {
        const run = workflowRun('abc010', {
          outcome: RUN_OUTCOME.CANCELLED,
        });
        mocks.executeCliConfig.mockImplementationOnce(
          (_config, _context, options) =>
            Effect.gen(function* () {
              if (!run.ok) return run;
              if (options.openWorkflowOutput)
                yield* options.openWorkflowOutput(run.result, [], () => true);
              options.onInterruptedRunFinalized?.('abc010');
              return run;
            }),
        );
        const resumeInvocation = path.join(
          path.sep,
          'tmp',
          'resume-invocation',
        );
        const persistedWorkspace = path.join(
          path.sep,
          'tmp',
          'persisted-workspace',
        );
        const context = createRunCommandCliContext({ cwd: resumeInvocation });
        const { executeCliWorkflowConfig: nativeExecute } =
          yield* Effect.promise(() => import('@cli/commands/workflow'));
        const executeCliWorkflowConfig = (
          ...args: Parameters<typeof nativeExecute>
        ) => Effect.provide(nativeExecute(...args), fakeProcessServices());

        const { createTestSession } = yield* Effect.promise(
          () => import('@test/support/sessionTestUtils'),
        );
        const session = createTestSession();
        // The mocked launch boundary skips the launch's own `run.start`
        // commit; the session opens the run before finalization writes it.
        yield* seedStartedRun(session, 'abc010');
        const exitCode = yield* executeCliWorkflowConfig(
          {
            agent: 'polish',
            model: 'deepseekT',
            workingDirectory: persistedWorkspace,
            agentCategory: AgentCategory.Workflow,
          },
          context,
          {
            session: Effect.succeed(session),
            runtime: testRuntime(),
            shutdownScope: installedHost().platform.shutdownScope,
          },
        ).pipe(Effect.ensuring(closeSessionOf(session)));

        expect(exitCode).toBe(CliExitCode.Interrupted);
        expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
        expect(
          cliLogSinksMock.writeTextStderrAndWait,
        ).toHaveBeenCalledExactlyOnceWith(
          expectedRecoveryHint(context, 'abc010', persistedWorkspace),
        );
      }),
  );

  it.effect(
    'prints recovery when the original process directory is unavailable',
    () =>
      Effect.gen(function* () {
        const run = workflowRun('abc011', {
          outcome: RUN_OUTCOME.CANCELLED,
        });
        mockWorkflowRun(run, true);
        const stableWorkspace = path.join(path.sep, 'tmp', 'stable-workspace');
        const context = createRunCommandCliContext({ cwd: stableWorkspace });
        const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
          throw new Error('launch directory was deleted');
        });
        const { executeCliWorkflowConfig: nativeExecute } =
          yield* Effect.promise(() => import('@cli/commands/workflow'));
        const executeCliWorkflowConfig = (
          ...args: Parameters<typeof nativeExecute>
        ) => Effect.provide(nativeExecute(...args), fakeProcessServices());

        const { createTestSession } = yield* Effect.promise(
          () => import('@test/support/sessionTestUtils'),
        );
        const session = createTestSession();
        // The hint advertises only a resumable run, so the cancelled run's
        // own checkpoint is what the real resumability read has to find; the
        // launch's `run.start` commit the mock boundary skips rides with it.
        yield* seedResumableCheckpoint(session, 'abc011');
        const exitCode = yield* executeCliWorkflowConfig(
          {
            agent: 'polish',
            model: 'deepseekT',
            workingDirectory: stableWorkspace,
            agentCategory: AgentCategory.Workflow,
          },
          context,
          {
            session: Effect.succeed(session),
            runtime: testRuntime(),
            shutdownScope: installedHost().platform.shutdownScope,
          },
        ).pipe(Effect.ensuring(closeSessionOf(session)));
        expect(exitCode).toBe(CliExitCode.Interrupted);
        expect(cwdSpy).toHaveBeenCalledOnce();
        cwdSpy.mockRestore();
        expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledExactlyOnceWith(
          `Resume this workflow with: ${formatResumeCommand(
            context.commandName,
            'abc011',
            {
              cwd: stableWorkspace,
              processCwd: undefined,
              approvalPolicy: context.approvalPolicy,
              outputFormat: context.outputFormat,
              print: true,
            },
          )}`,
        );
      }),
  );

  it.effect.each(['json', 'ndjson'] as const)(
    'keeps %s stdout free of the cancellation recovery hint',
    (outputFormat) =>
      Effect.gen(function* () {
        mockWorkflowRun(
          workflowRun('abc007', {
            outcome: RUN_OUTCOME.CANCELLED,
          }),
          true,
        );
        // The hint advertises only a resumable run: the cancelled run's own
        // checkpoint is what the real resumability read has to find.
        yield* seedResumableCheckpoint(currentSession(), 'abc007');

        const exitCode = yield* workflowProgram(
          {},
          createRunCommandCliContext({ outputFormat }),
        );

        expect(exitCode).toBe(CliExitCode.Interrupted);
        expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
        expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledExactlyOnceWith(
          expectedRecoveryHint(
            createRunCommandCliContext({ outputFormat }),
            'abc007',
          ),
        );
      }),
  );

  it.effect('does not print a recovery command for failed workflows', () =>
    Effect.gen(function* () {
      mockWorkflowRun(
        workflowRun('abc012', { outcome: RUN_OUTCOME.FAILED }),
        true,
      );

      const exitCode = yield* workflowProgram();

      expect(exitCode).toBe(CliExitCode.AgentError);
      expect(cliLogSinksMock.writeTextStdout).not.toHaveBeenCalled();
      expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'reports missing instruction files before starting platform or input work',
    () =>
      Effect.gen(function* () {
        // `resolveFileBackedInstruction` reports a missing file as a typed
        // `CliUsageError` on the Effect failure channel, unlike the command's
        // own `throw`, which Effect surfaces as a defect.
        const error = yield* Effect.flip(
          workflowProgram({ instructionFile: 'missing-prompt.md' }),
        );
        expect(error.message).toMatch(
          /--instruction-file: file not found: missing-prompt\.md/,
        );

        expect(cliInitPlatformMock.initCliPlatform).not.toHaveBeenCalled();
        expect(mocks.resolveCliRunAgent).not.toHaveBeenCalled();
        expectNoModelOrInputWork();
      }),
  );
});
