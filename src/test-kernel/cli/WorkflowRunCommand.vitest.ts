/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Shared mock registrations must evaluate before anything that loads
// the mocked modules — keep these imports immediately after the vitest
// import.
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { DocumentsResult } from '@texra/shared/plugins/documentOutputs';
import type { runHeadlessAgent } from '@cli/commands/workflow';
import type { CliContext } from '@cli/runtime/cliContext';
import type {
  CliExecuteOptions,
  CliConfigExecuteResult,
} from '@cli/runtime/executeCli';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import { qualifyAggregateId, RUN_OUTCOME, type RunId } from '@shared/schemas';
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
type WorkflowExecuteResult = CliConfigExecuteResult;
type WorkflowRunPayload = Extract<
  WorkflowExecuteResult,
  { ok: true }
>['result'];

/** The session the suite's init installs, as the command resolved it. */
let fixtureSession: SessionHandle | undefined;

/** Run ids the mocked launch has reported, waiting for the opening row its
 *  real counterpart would have committed. */
let pendingRunStarts: string[] = [];

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
      (runId) => seedStartedRun(fixtureSession!, runId),
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

function mockWorkflowRun(result: WorkflowExecuteResult): void {
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
  if (result.ok) pendingRunStarts.push(result.result.runId);
  mocks.executeCliConfig.mockImplementationOnce(implementation);
}

/** Materializes the round-1 output file the copy target is sourced from. */
async function writeGeneratedOutput(root: string): Promise<string> {
  const generated = path.join(root, 'run', 'r1', 'paper.tex');
  await fs.mkdir(path.dirname(generated), { recursive: true });
  await fs.writeFile(generated, 'polished');
  return generated;
}

/**
 * The run's opening row, committed by the fixture session itself: the first
 * append claims the aggregate for this process, the way the launch's own
 * commit claims it before finalization writes.
 */
const seedStartedRun = (session: SessionHandle, runId: string) =>
  session.log.transact([
    {
      type: 'run.start',
      aggregateId: qualifyAggregateId('run', runId as RunId),
      identity: { kind: 'agent', agent: 'polish' },
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    },
  ]);

describe('CLI run command, workflow agents', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    pendingRunStarts = [];
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
        mockWorkflowRun(workflowRun('abc003', { outputs: [outputSummary] }));

        const exitCode = yield* workflowProgram(
          { outputDir: 'out' },
          createRunCommandCliContext({ cwd: workspace }),
        );

        expect(exitCode).toBe(0);
        expect(
          yield* Effect.promise(() =>
            fs.readFile(path.join(workspace, 'out', 'paper.tex'), 'utf8'),
          ),
        ).toBe('polished');
      }),
    ),
  );

  it.effect(
    'keeps failed output in run storage and preserves the requested --output destination',
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
          mockWorkflowRun(
            workflowRun('abc00a', {
              outcome: RUN_OUTCOME.FAILED,
              outputs: [outputSummary],
            }),
          );
          const target = path.join(root, 'polished.tex');
          yield* Effect.promise(() => fs.writeFile(target, 'keep-me'));

          const exitCode = yield* workflowProgram(
            { output: 'polished.tex' },
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
          expect(emission?.text).toContain('/tmp/runs/abc00a');
        }),
      ),
  );
});
