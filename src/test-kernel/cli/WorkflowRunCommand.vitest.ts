import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { beforeEach, expect, vi } from 'vitest';

import { layer } from '@effect/vitest';
import { Effect, Context, Schema } from 'effect';
import {
  RoundOutputSchema,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import {
  DocumentTaskOptionsSchema,
  documentsOutputFact,
} from '@texra/shared/plugins/documents';
import type { runHeadlessAgent } from '@cli/commands/workflow';
import {
  provideCliInvocation,
  type CliContext,
} from '@cli/runtime/platform/cliContext';
import {
  CliPlatform,
  type CliPlatformServices,
} from '@cli/runtime/platform/initPlatform';
import type {
  CliExecuteOptions,
  CliConfigExecuteResult,
} from '@cli/runtime/headless/executeCli';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import {
  qualifyAggregateId,
  RUN_OUTCOME,
  RunIdSchema,
  type RunId,
} from '@texra-ai/harness/schemas';
import { createRunCommandCliContext } from '@test/cli/fixtures/cliContext';
import { withTempDirEffect } from '@test/support/tempDirPlatform';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionLog } from '@shared/session/runHistory';

const mocks = vi.hoisted(() => {
  return {
    executeCliConfig: vi.fn(),
    emitCliResult: vi.fn(),
    withExpandedRunInputs: vi.fn(),
    resolveCliRunAgent: vi.fn(),
    selectCliRunModel: vi.fn(),
  };
});

vi.mock('@common/storage/storageLayout', async (importActual) => ({
  ...(await importActual<typeof import('@common/storage/storageLayout')>()),
  runDirUnder: vi.fn(
    (_storageRoot: string, runId: string) => `/tmp/runs/${runId}`,
  ),
}));

vi.mock('@cli/runtime/models/runModel', () => ({
  buildHeadlessRunContext: vi.fn((context: CliContext) => ({
    ...context,
    quietLogs: true,
    renderRunProgress: false,
  })),
  selectCliRunModel: mocks.selectCliRunModel,
}));

vi.mock('@cli/commands/_helpers/output', async (importOriginal) => {
  const { Effect } = await import('effect');
  return {
    ...(await importOriginal<typeof import('@cli/commands/_helpers/output')>()),
    emitCliResult: (result: unknown) =>
      Effect.sync(() => mocks.emitCliResult(result)),
  };
});

vi.mock('@cli/runtime/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/agents')>()),
  resolveCliRunAgent: mocks.resolveCliRunAgent,
}));

vi.mock('@cli/runtime/headless/executeCli', () => ({
  // A pass-through, so the mocked seam has the real module's Effect-returning
  // shape and every stub below returns the program the command yields.
  executeCliConfig: (...args: unknown[]) => mocks.executeCliConfig(...args),
}));

vi.mock('@cli/runtime/headless/workflowInputs', () => ({
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

/** Runs the mocked launch has reported, waiting for the opening row (and
 *  the documents row) their real counterpart would have committed. */
let pendingRunStarts: { runId: RunId; rounds: readonly RoundOutput[] }[] = [];

/**
 * The workflow command's program over the shared happy-path inputs, on the
 * test's session: its platform hands the command the host's stores, and
 * the commands under test read `secrets`/`globalState` off them.
 */
function workflowProgram(
  init: Partial<WorkflowRunInit> = {},
  context: CliContext = createRunCommandCliContext(),
) {
  // The mocked launch boundary skips the launch's own `run.start` commit, so
  // the fixture session opens the run the mock reports first: an aggregate's
  // first row must be that start, and the claim it takes is the one the
  // finalization write below commits against.
  const starts = pendingRunStarts;
  pendingRunStarts = [];
  return Effect.gen(function* () {
    const session = yield* TestSession;
    const handle = yield* sessionHandleOf(session);
    // cast: the command reads only these members of its platform.
    const platform = {
      ...(yield* FakeHost).platform,
      session: Effect.succeed(session),
      runtime: yield* SessionGraph.runtime,
    } as unknown as CliPlatformServices;
    yield* Effect.forEach(
      starts,
      ({ runId, rounds }) => seedStartedRun(handle, runId, rounds),
      { discard: true },
    );
    return yield* nativeRun(context, {
      agent: 'polish',
      inputFiles: ['paper.tex'],
      contextFiles: [],
      instruction: '',
      options: Schema.decodeUnknownSync(DocumentTaskOptionsSchema)({}),
      ...init,
    }).pipe(
      provideCliInvocation(context),
      Effect.provideService(CliPlatform, Effect.succeed(platform)),
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

/** The documents row's round that wrote `absolutePath` at `r1/paper.tex`,
 *  revising `originalPath`. */
function roundWriting(absolutePath: string, originalPath: string): RoundOutput {
  return Schema.decodeUnknownSync(RoundOutputSchema)({
    round: 1,
    outputs: [
      {
        source: 'paper',
        round: 1,
        location: {
          kind: 'runStorage',
          absolutePath,
          relativePath: 'r1/paper.tex',
          runId: 'abc00a',
        },
        lineage: {
          base: { kind: 'external', absolutePath: originalPath },
          document: null,
        },
        diff: null,
      },
    ],
    compile: null,
    missingOutputs: [],
    latexdiffs: [],
    reply: null,
  });
}

function workflowRun(
  runId: string,
  outcome: WorkflowRunPayload['outcome'] = RUN_OUTCOME.COMPLETED,
): WorkflowExecuteResult {
  return {
    ok: true,
    result: {
      outcome,
      output: { response: '', files: [] },
      runId: Schema.decodeUnknownSync(RunIdSchema)(runId),
    },
  };
}

function mockWorkflowRun(
  result: WorkflowExecuteResult,
  rounds: readonly RoundOutput[] = [],
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
  if (result.ok) pendingRunStarts.push({ runId: result.result.runId, rounds });
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
const seedStartedRun = (
  session: Context.Context<SessionServices>,
  runId: RunId,
  rounds: readonly RoundOutput[],
) =>
  Context.get(session, SessionLog).transact([
    {
      type: 'run.start',
      aggregateId: qualifyAggregateId('run', runId),
      identity: { kind: 'agent', agent: 'polish' },
      takesFollowUps: false,
      parent: null,
      provenance: null,
    },
    ...(rounds.length === 0
      ? []
      : [
          {
            type: 'plugin.fact' as const,
            aggregateId: qualifyAggregateId('run', runId),
            parent: null,
            ...documentsOutputFact(rounds),
          },
        ]),
  ]);

layer(SessionGraph.hosted)('CLI run command, workflow agents', (it) => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingRunStarts = [];
    mocks.resolveCliRunAgent.mockReturnValue(
      Effect.succeed({
        name: 'polish',
        source: 'builtIn',
        path: '/agents/polish.yaml',
        tools: [],
        blocks: {
          task: {
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

  // A session of its own per case, released with it.
  it.layer(TestSession.layer(), { buildPerTest: true })((it) => {
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
            mockWorkflowRun(workflowRun('abc00a', RUN_OUTCOME.FAILED), [
              roundWriting(generated, path.join(root, 'paper.tex')),
            ]);
            const target = path.join(root, 'polished.tex');
            yield* Effect.promise(() => fs.writeFile(target, 'keep-me'));

            const exitCode = yield* workflowProgram(
              { output: 'polished.tex' },
              createRunCommandCliContext({ cwd: root }),
            );

            expect(exitCode).toBe(CliExitCode.AgentError);
            expect(
              yield* Effect.promise(() => fs.readFile(target, 'utf8')),
            ).toBe('keep-me');
            const emission = mocks.emitCliResult.mock.calls[0]?.[0];
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
});
