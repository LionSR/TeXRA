/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import { beforeEach, describe, expect, vi } from 'vitest';

// Shared mock registrations must evaluate before anything that loads
// the mocked modules — keep these imports immediately after the vitest
// import.
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { cliOutputMock } from '@test/support/cliOutputMock';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { ensureError } from '@utils/errors/errorMessage';

import type { CliContext } from '@cli/runtime/cliContext';
import { testRuntime } from '@test/support/testProcessRuntime';
import { RUN_OUTCOME } from '@shared/schemas';
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

describe('CLI run command, tool-use agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The CLI init hands its caller the platform's stores; the commands
    // under test read `secrets`/`globalState` off what it returns.
    const platform = { ...installedHost().platform, runtime: testRuntime() };
    cliInitPlatformMock.initCliPlatform.mockReturnValue(
      Effect.succeed(platform),
    );
    mocks.withExpandedRunInputs.mockResolvedValue({
      inputFiles: ['problem.md'],
      contextFiles: ['notes.md'],
    });
    mocks.resolveCliRunAgent.mockReturnValue(
      Effect.succeed({
        name: 'chat',
        source: 'builtIn',
        path: '/agents/chat.yaml',
        tools: ['read_file'],
        blocks: {},
      }),
    );
    mocks.selectCliRunModel.mockImplementation(
      (_context: CliContext, model: string | undefined) =>
        Effect.succeed(model ?? 'openai/gpt-5.4-2026-03-05'),
    );
    mocks.executeCliToolUseConfig.mockResolvedValue({
      ok: true,
      result: {
        runId: 'run-1',
        outcome: RUN_OUTCOME.COMPLETED,
        output: {
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
          model: 'openai/gpt-5.4-2026-03-05',
          instruction: 'Assess the proof concisely.',
        });

        expect(exitCode).toBe(0);
        const config = mocks.executeCliToolUseConfig.mock.calls[0]?.[0];
        expect(config?.displayInstruction).toBe('Assess the proof concisely.');
        expect(config?.instruction).toContain('Primary user input files:');
        expect(config?.instruction).toContain('- "problem.md"');
        expect(config?.instruction).toContain('Read-only context files:');
        expect(config?.instruction).toContain('- "notes.md"');
        expect(config?.instruction).toContain('Assess the proof concisely.');
        const emission = cliOutputMock.emitCliResult.mock.calls[0]?.[1];
        expect(emission?.json).toEqual({
          runId: 'run-1',
          outcome: RUN_OUTCOME.COMPLETED,
          output: {
            response: 'Correct.',
            files: [],
          },
          workingDirectory: '/tmp/project',
        });
        expect(emission?.ndjson).toEqual({
          kind: 'agent-result',
          result: emission.json,
        });
        expect(emission?.text).toBe('Correct.');
      }),
  );
});
