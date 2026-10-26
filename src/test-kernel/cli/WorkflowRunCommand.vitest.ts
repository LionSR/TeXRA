/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Shared mock registrations must evaluate before anything that loads
// the mocked modules — keep these imports immediately after the vitest
// import.
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { cliLogSinksMock } from '@test/support/cliLogSinksMock';

import { it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { asDocumentTask } from '@test/support/ProgressControllerHarnesses';
import type { DocumentsResult } from '@texra/shared/plugins/documentOutputs';
import type { runHeadlessAgent } from '@cli/commands/workflow';
import { formatResumeCommand } from '@cli/chat/tui/state/resumeHint';
import type { CliContext } from '@cli/runtime/cliContext';
import type {
  CliExecuteOptions,
  CliConfigExecuteResult,
} from '@cli/runtime/executeCli';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import {
  qualifyAggregateId,
  RUN_OUTCOME,
  RunRecordFieldsSchema,
  type RunId,
} from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { createRunCommandCliContext } from '@test/cli/fixtures/cliContext';
import {
  fakeProcessServices,
  installedHost,
} from '@test/support/setupPlatform';
import { createTestSession, seedRows } from '@test/support/sessionTestUtils';
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
type WorkflowExecuteResult = CliConfigExecuteResult;
type WorkflowRunPayload = Extract<
  WorkflowExecuteResult,
  { ok: true }
>['result'];

function expectedRecoveryHint(
  context: CliContext,
  runId: string,
  workingDirectory = context.cwd,
): string {
  return `Resume this task with: ${formatResumeCommand(
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
/** The output files a run's recorded configuration names, for the runs
 *  that record some. */
const recordedOutputFiles = new Map<string, readonly string[]>();

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
      Pick<DocumentsResult, 'outputs' | 'compileFailures'>
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
        response: '',
        files: [],
        // A document task's recipe returns its documents.
        structured: {
          outputs: [],
          compileFailures: [],
          diffs: [],
          ...output,
        },
      },
      runId: runId as RunId,
    },
  };
}

function mockWorkflowRun(
  result: WorkflowExecuteResult,
  once = false,
  /** What the launch resolved the agent's declared outputs to, as the
   *  run's recorded configuration states them. */
  agentDefaultOutputFiles: readonly string[] = [],
): void {
  // The finalization runs the command's post-run step on the committed
  // result, as the real skeleton does.
  const implementation = (
    _config: unknown,
    _context: unknown,
    options: Pick<CliExecuteOptions, 'afterRun'>,
  ) =>
    result.ok && options.afterRun
      ? Effect.as(options.afterRun(result.result), result)
      : Effect.succeed(result);
  if (result.ok) {
    pendingRunStarts.push(result.result.runId);
    if (agentDefaultOutputFiles.length > 0)
      recordedOutputFiles.set(result.result.runId, agentDefaultOutputFiles);
  }
  if (once) mocks.executeCliConfig.mockImplementationOnce(implementation);
  else mocks.executeCliConfig.mockImplementation(implementation);
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
): Promise<void> {
  const generated = await writeGeneratedOutput(root);
  mockWorkflowRun(
    workflowRun(runId, {
      outcome: RUN_OUTCOME.CANCELLED,
      outputs: [runOutputSummary(generated, path.join(root, 'paper.tex'))],
    }),
    true,
  );
}

/**
 * The run's opening row, committed by the fixture session itself: the first
 * append claims the aggregate for this process, the way the launch's own
 * commit claims it before finalization writes.
 */
const seedStartedRun = (session: SessionHandle, runId: string) =>
  Effect.gen(function* () {
    if (seededRunIds.has(runId)) return;
    yield* session.log.transact([
      {
        type: 'run.start',
        aggregateId: qualifyAggregateId('run', runId as RunId),
        identity: { kind: 'agent', agent: 'polish' },
        userFollowUpSupport: 'unsupported',
        parent: null,
        provenance: null,
      },
    ]);
    // The configuration the launch recorded, for a run that names its
    // output files there.
    const outputFiles = recordedOutputFiles.get(runId);
    if (outputFiles !== undefined)
      yield* seedRows(session.log)([
        {
          type: 'run.config',
          aggregateId: qualifyAggregateId('run', runId as RunId),
          config: Schema.decodeUnknownSync(RunRecordFieldsSchema)(
            asDocumentTask({
              agent: 'polish',
              model: 'test-model',
              inputFiles: ['paper.tex'],
              outputFiles: [...outputFiles],
            }),
          ),
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
    const cell = yield* session.runHistory.open(runId as RunId, {
      activation: () => Effect.succeed([]),
    });
    yield* cell.append([
      {
        type: 'run.position',
        aggregateId: qualifyAggregateId('run', runId as RunId),
        payload: { family: 'toolUse', at: 'turn.ready', turn: 0 },
      },
    ]);
  });

describe('CLI run command, workflow agents', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    pendingRunStarts = [];
    recordedOutputFiles.clear();
    seededRunIds.clear();
    // The CLI init hands its caller the platform's stores; the commands
    // under test read `secrets`/`globalState` off what it returns.
    const session = await Effect.runPromise(createTestSession());
    fixtureSession = session;
    const platform = {
      ...installedHost().platform,
      session: Effect.succeed(testSessionOf(session)),
      runtime: testRuntime(),
    };
    cliInitPlatformMock.initCliPlatform.mockReturnValue(
      Effect.succeed(platform),
    );
    mocks.resolveCliRunAgent.mockReturnValue(
      Effect.succeed({
        name: 'polish',
        source: 'builtIn',
        path: '/agents/polish.yaml',
        tools: [],
        blocks: {
          task: {
            rewrite: true,
            outputs: [],
            files: {},
            prefix: '',
            requests: ['Polish the documents.'],
          },
        },
      }),
    );
    mocks.selectCliRunModel.mockImplementation(
      (_context: CliContext, model: string | undefined) =>
        Effect.succeed(model ?? 'deepseek/deepseek-v4-flash'),
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

  it.effect('copies the outputs into --output-dir', () =>
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
      }),
    ),
  );

  it.effect(
    'prints a resumable recovery command for a cancelled workflow',
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
            cliLogSinksMock.writeTextStderr,
          ).toHaveBeenCalledExactlyOnceWith(
            expectedRecoveryHint(context, 'abc007'),
          );
        }),
      ),
  );

  it.effect(
    'keeps non-empty cancelled outputs in run storage without copying to --output',
    () =>
      withTempDirEffect('texra-workflow-', (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => setupCancelledOutput(root, 'abc008'));
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
            output: { documents: { outputs: [outputSummary] } },
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

  // Issue #12162: a remote agent's catalog listing carries no
  // `task.outputs`, so only the definition the launch loads declares
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
});
