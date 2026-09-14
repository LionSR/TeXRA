/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import { beforeEach, describe, expect, vi } from 'vitest';

// Shared mock registrations must evaluate before anything that loads
// the mocked modules — keep these imports immediately after the vitest
// import (enforced by architecture/supportMockImportOrder.vitest.ts).
import '@test/support/agentCatalogMock';
import '@test/support/agentStorageFinalizationMock';
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { cliLogSinksMock } from '@test/support/cliLogSinksMock';
import { cliOutputMock } from '@test/support/cliOutputMock';

import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { ensureError } from '@utils/errors/errorMessage';

import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { RUN_OUTCOME, AgentCategory } from '@shared/schemas';
import { createRunCommandCliContext } from '@test/cli/fixtures/cliContext';
import {
  fakeProcessServices,
  type FakeProcessServices,
  installedHost,
} from '@test/support/setupPlatform';

const mocks = vi.hoisted(() => ({
  executeCliToolUseConfig: vi.fn(),
  withExpandedRunInputs: vi.fn(),
  resolveCliRunAgent: vi.fn(),
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
  resolveCliRunAgent: mocks.resolveCliRunAgent,
}));

vi.mock('@cli/runtime/executeCli', () => ({
  executeCliConfig: vi.fn(),
  executeCliToolUseConfig: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => mocks.executeCliToolUseConfig(...args),
      catch: ensureError,
    }),
}));

vi.mock('@cli/runtime/workflowInputs', () => ({
  // The spy records the call the command made — continuation included, so the
  // suite can still pin what was handed to it — and answers with the inputs to
  // expand to. Running that continuation is left to this fiber rather than to
  // the spy, so the rest of the program stays inside the test's runtime
  // instead of re-entering a fresh one through `Effect.runPromise`.
  withExpandedRunInputs: (
    ...args: Parameters<
      typeof import('@cli/runtime/workflowInputs').withExpandedRunInputs<
        unknown,
        unknown,
        FakeProcessServices
      >
    >
  ) =>
    Effect.gen(function* () {
      const inputs = yield* Effect.tryPromise({
        try: () => mocks.withExpandedRunInputs(...args),
        catch: ensureError,
      });
      return yield* args[4](inputs as Parameters<(typeof args)[4]>[0]);
    }),
  hasMixedStdinWorkflowInputSpecs: vi.fn(() => false),
  WORKFLOW_INPUT_REQUIRED_MESSAGE:
    'At least one workflow input file is required.',
}));

// Hoisted out of each test body — a dynamic import()'s result is cached, so
// one call here serves every test below.
const { runHeadlessAgent: nativeRun } = await import('@cli/commands/workflow');

/** The run command's program, over the installed fake host's services. */
const runToolUseAgent = (...args: Parameters<typeof nativeRun>) =>
  Effect.provide(nativeRun(...args), fakeProcessServices());

/**
 * The usage error a refused run carries. `runHeadlessAgent` reports one by
 * throwing `CliUsageError` from its `Effect.fn` body, which Effect surfaces as
 * a defect rather than a typed failure — `Effect.flip` does not succeed on it,
 * so the assertion reads the cause.
 */
function usageErrorFrom(exit: Exit.Exit<number, Error>): Error {
  if (!Exit.isFailure(exit)) throw new Error('The run was expected to fail.');
  const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect;
  if (!(defect instanceof Error))
    throw new Error(`The run failed without a usage error: ${exit.cause}`);
  return defect;
}

describe('CLI run command, tool-use agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The CLI init hands its caller the platform's stores; the commands
    // under test read `secrets`/`globalState` off what it returns.
    const { platform } = installedHost();
    cliInitPlatformMock.initLocalCliPlatform.mockResolvedValue(platform);
    cliInitPlatformMock.initCliPlatform.mockResolvedValue(platform);
    mocks.withExpandedRunInputs.mockResolvedValue({
      inputFiles: ['problem.md'],
      contextFiles: ['notes.md'],
    });
    mocks.resolveCliRunAgent.mockResolvedValue({
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
        runId: 'run-1',
        outcome: RUN_OUTCOME.COMPLETED,
        output: {
          category: AgentCategory.ToolUse,
          response: 'Correct.',
          files: [],
        },
        workingDirectory: '/tmp/project',
      },
      exitCode: 0,
    });
  });

  it.effect(
    'anchors headless tool-use runs on provided files without polluting display text',
    () =>
      Effect.gen(function* () {
        const exitCode = yield* runToolUseAgent(createRunCommandCliContext(), {
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
        ).toBeLessThan(mocks.resolveCliRunAgent.mock.invocationCallOrder[0]);
        expect(mocks.resolveCliRunAgent).toHaveBeenCalledWith('chat');
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
          runId: 'run-1',
          outcome: RUN_OUTCOME.COMPLETED,
          output: {
            category: AgentCategory.ToolUse,
            response: 'Correct.',
            files: [],
          },
          workingDirectory: '/tmp/project',
        });
        // `outcome` is the only terminal fact the headless JSON publishes, what
        // the run produced rides `output`, and the run id is `runId`: the result
        // is the run's result, not a renamed copy of it.
        expect(Object.keys(emission?.json ?? {})).toEqual([
          'runId',
          'outcome',
          'output',
          'workingDirectory',
        ]);
        expect(emission?.ndjson).toEqual({
          kind: 'agent-result',
          result: emission.json,
        });
        expect(emission?.text).toBe('Correct.');
      }),
  );

  it.effect(
    'marks materialized stdin as unavailable for recovery advertising',
    () =>
      Effect.gen(function* () {
        mocks.withExpandedRunInputs.mockResolvedValueOnce({
          inputFiles: ['.texra-tmp/stdin.tex'],
          contextFiles: [],
          stdinInputPath: '.texra-tmp/stdin.tex',
        });
        yield* runToolUseAgent(createRunCommandCliContext(), {
          agent: 'chat',
          inputFiles: ['-'],
          contextFiles: [],
          model: 'gpt54',
          instruction: 'Assess the proof.',
        });

        expect(mocks.executeCliToolUseConfig.mock.calls[0]?.[2]).toMatchObject({
          recoveryInputIsDurable: false,
        });
      }),
  );

  it.effect('publishes the canonical outcome for a shutdown cancellation', () =>
    Effect.gen(function* () {
      mocks.executeCliToolUseConfig.mockResolvedValueOnce({
        ok: true,
        result: {
          runId: 'run-interrupted',
          outcome: RUN_OUTCOME.CANCELLED,
          output: { category: AgentCategory.ToolUse, response: '', files: [] },
          workingDirectory: '/tmp/project',
        },
        exitCode: CliExitCode.Interrupted,
      });
      const exitCode = yield* runToolUseAgent(createRunCommandCliContext(), {
        agent: 'chat',
        inputFiles: ['problem.md'],
        contextFiles: [],
        instruction: 'Assess the proof.',
      });

      expect(exitCode).toBe(CliExitCode.Interrupted);
      expect(cliOutputMock.emitCliResult.mock.calls[0]?.[1].json).toMatchObject(
        { outcome: RUN_OUTCOME.CANCELLED },
      );
    }),
  );

  it.effect('reports missing instruction before resolving the model', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runToolUseAgent(createRunCommandCliContext(), {
          agent: 'chat',
          inputFiles: ['problem.md'],
          contextFiles: [],
          model: 'gpt54',
          instruction: '',
        }),
      );

      expect(usageErrorFrom(exit).message).toBe(
        'Provide --instruction or --instruction-file.',
      );
      expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
      expect(mocks.withExpandedRunInputs).not.toHaveBeenCalled();
    }),
  );

  // Neither category can run an invocation with no instruction and no input,
  // so it is refused before the platform init and the agent-catalog fetch a
  // signed-in session would otherwise pay for on a plain usage error.
  it.effect(
    'refuses an invocation no category can run without resolving the agent',
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          runToolUseAgent(createRunCommandCliContext(), {
            agent: 'chat',
            inputFiles: [],
            contextFiles: ['notes.md'],
            instruction: '',
          }),
        );

        expect(usageErrorFrom(exit).message).toBe(
          'Provide --instruction or --instruction-file for a tool-use agent, or --input for a workflow agent.',
        );
        expect(cliInitPlatformMock.initLocalCliPlatform).not.toHaveBeenCalled();
        expect(mocks.resolveCliRunAgent).not.toHaveBeenCalled();
      }),
  );

  // The one headless `run` command carries both categories' flags, so the
  // workflow-only destinations have to be refused once the agent is known.
  it.effect.each(['output', 'outputDir'] as const)(
    'refuses the workflow-only --%s destination for a tool-use agent',
    (flag) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          runToolUseAgent(createRunCommandCliContext(), {
            agent: 'chat',
            inputFiles: ['problem.md'],
            contextFiles: [],
            instruction: 'Assess the proof.',
            [flag]: 'out.tex',
          }),
        );

        expect(usageErrorFrom(exit).message).toBe(
          `${flag === 'output' ? '--output' : '--output-dir'} is only available for workflow agents; "chat" is a toolUse agent.`,
        );
        expect(mocks.selectCliRunModel).not.toHaveBeenCalled();
        expect(mocks.executeCliToolUseConfig).not.toHaveBeenCalled();
      }),
  );
});
