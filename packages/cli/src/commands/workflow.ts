import * as path from 'node:path';
import { Effect, Result } from 'effect';

import {
  buildCliWorkflowResultMeta,
  deriveResumability,
  getExecutionRecords,
  type ResumabilityDecision,
} from '@agent/storage';
import {
  isTerminalPersistedCompileRejection,
  type AgentConfigPayload,
} from '@agent/runtime';
import { effectRuntime } from '@platform/processRuntime';
import { RUN_OUTCOME, type ExecutionId, AgentCategory } from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { initializeCliTranscriptSession } from '../runtime/transcriptSession';

import {
  CliUsageError,
  readCliStdinText,
  type CliContext,
} from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import {
  formatInterruptedResumeHint,
  tryReadCliCwd,
  writeInterruptedResumeHint,
} from '../runtime/interruptedResumeHint';
import { writeErrorStderr, writeTextStderr } from '../runtime/logSinks';
import {
  buildHeadlessRunContext,
  selectCliRunModel,
} from '../runtime/runModel';
import {
  resolveCliLaunchAgent,
  WORKFLOW_AGENT_NAME_DESCRIPTION,
} from '../runtime/agents';
import { initLocalCliPlatform } from '../runtime/initPlatform';
import { installCliProcessRuntime } from '../runtime/cliProcessRuntime';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { emitCliResult } from './_helpers/output';
import {
  AGENT_RUN_GLOBAL_ARGS,
  collectCommonAgentRunFlags,
  optionalStringFlagValue,
  optString,
} from './_helpers/globalArgs';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import {
  executeCliConfig,
  type CliConfigExecuteOptions,
} from '../runtime/runExecution';
import { runOutcomeExitCode } from '../runtime/terminalStatus';
import {
  hasMixedStdinWorkflowInputSpecs,
  withExpandedRunInputs,
} from '../runtime/workflowInputs';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  type CliWorkflowRunResult,
  expectedOutputFilesForOutputDir,
  formatWorkflowTextResult,
  resolveWorkflowOutput,
  resumeWorkflowOutputDirectory,
  resumeWorkflowOutputFile,
} from '../runtime/workflowOutput';

const MULTI_INPUT_OUTPUT_MESSAGE =
  'Use --output-dir for multi-input workflow runs; --output is only for a single final artifact.';

function absoluteOutputDestination(
  destination: string | undefined,
  cwd: string,
): string | undefined {
  if (!destination) return undefined;
  return path.resolve(cwd, destination);
}

interface WorkflowRunInit {
  readonly agent: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly output?: string;
  readonly outputDir?: string;
  readonly model?: string;
  readonly instruction: string;
  readonly instructionFile?: string;
}

export const runWorkflowAgent = Effect.fn('runWorkflowAgent')(function* (
  context: CliContext,
  init: WorkflowRunInit,
): Effect.fn.Return<number, Error> {
  if (init.output && init.outputDir) {
    throw new CliUsageError('Use either --output or --output-dir, not both.');
  }
  // Reject `--output-dir <path>` early when the path already points at a
  // non-directory (else we'd run the full workflow and EEXIST at the end).
  yield* Effect.tryPromise({
    try: () => assertOutputDirAvailable(init.outputDir, context.cwd),
    catch: ensureError,
  });
  // Same fast-fail for `--output <path>`: existing directory or file-typed
  // parent component blows up at copy time (`EISDIR` / `EEXIST`) after the
  // full agent run otherwise.
  yield* Effect.tryPromise({
    try: () => assertOutputFileAvailable(init.output, context.cwd),
    catch: ensureError,
  });
  const instruction = yield* Effect.tryPromise({
    try: () => resolveFileBackedInstruction(init, context.cwd),
    catch: ensureError,
  });

  yield* Effect.tryPromise({
    try: () => initLocalCliPlatform(context),
    catch: ensureError,
  });
  // Pre-validate the resolved agent so usage errors land before stdin is read
  // or the runtime host starts.
  const agent = yield* Effect.tryPromise({
    try: () => resolveCliLaunchAgent(init.agent, 'run'),
    catch: ensureError,
  });
  if (init.output && hasMixedStdinWorkflowInputSpecs(init.inputFiles)) {
    throw new CliUsageError(MULTI_INPUT_OUTPUT_MESSAGE);
  }

  return yield* withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    context.cwd,
    { readStdinText: readCliStdinText },
    ({ inputFiles, contextFiles, stdinInputPath }) =>
      Effect.gen(function* () {
        if (init.output && inputFiles.length > 1) {
          throw new CliUsageError(MULTI_INPUT_OUTPUT_MESSAGE);
        }

        const model = yield* Effect.tryPromise({
          try: () => selectCliRunModel(context, init.model, 'run'),
          catch: ensureError,
        });
        const runContext = buildHeadlessRunContext(context);
        const expectedOutputFiles = init.outputDir
          ? expectedOutputFilesForOutputDir(agent, inputFiles, stdinInputPath)
          : undefined;
        // Persist CLI destinations absolutely so resumption has one path
        // representation and never reconstructs output locations.
        const cliOutputFile = absoluteOutputDestination(
          init.output,
          runContext.cwd,
        );
        const cliOutputDirectory = absoluteOutputDestination(
          init.outputDir,
          runContext.cwd,
        );
        const config: AgentConfigPayload = {
          agent: init.agent,
          model,
          inputFiles,
          contextFiles,
          outputFiles: [],
          ...(cliOutputFile !== undefined || cliOutputDirectory !== undefined
            ? {
                cli: {
                  outputFile: cliOutputFile,
                  outputDirectory: cliOutputDirectory,
                  expectedOutputFiles: expectedOutputFiles
                    ? [...expectedOutputFiles]
                    : undefined,
                },
              }
            : {}),
          instruction,
          workingDirectory: runContext.cwd,
          agentCategory: AgentCategory.Workflow,
        };

        return yield* executeCliWorkflowConfig(config, runContext, {
          categoryMismatchMessage: `Agent "${init.agent}" resolved to a non workflow run.`,
          recoveryInputIsDurable: stdinInputPath === undefined,
        });
      }),
  );
});

/**
 * Execute a workflow config headless and surface its outputs: run through the
 * shared CLI execution skeleton, copy `--output`/`--output-dir` artifacts,
 * persist the result metadata, report an output failure back to the live run
 * lifecycle, emit the result in the requested format, and map the outcome to
 * an exit code. Shared by `texra run` (fresh runs) and `texra resume`
 * (workflow continuation under the persisted execution id).
 */
export const executeCliWorkflowConfig = Effect.fn('executeCliWorkflowConfig')(
  function* (
    config: AgentConfigPayload,
    runContext: CliContext,
    options: {
      readonly categoryMismatchMessage: string;
      readonly recoveryInputIsDurable?: boolean;
      readonly executionId?: ExecutionId;
      readonly modelHandlerCompatibilityKey?: CliConfigExecuteOptions['modelHandlerCompatibilityKey'];
    },
  ): Effect.fn.Return<number, Error> {
    const session = yield* Effect.tryPromise({
      try: initializeCliTranscriptSession,
      catch: ensureError,
    });
    let workflowResult: CliWorkflowRunResult | undefined;
    let workflowOutputError: unknown;
    let resumeHintWritten = false;
    // The persisted `cli` block is the single representation of where this run
    // writes; never take the destinations a second time as call options.
    const output = resumeWorkflowOutputFile(config);
    const outputDir = resumeWorkflowOutputDirectory(config);
    const expectedOutputFiles = config.cli?.expectedOutputFiles ?? undefined;
    const recoveryProcessCwd = tryReadCliCwd();
    const recoveryInputIsDurable = options.recoveryInputIsDurable ?? true;
    const canAdvertiseInterruptedExecution = (
      resumability: Extract<ResumabilityDecision, { kind: 'checkpoint' }>,
    ): boolean => {
      const shared = resumability.flowRecord.shared;
      const lastError =
        typeof shared === 'object' && shared !== null
          ? (shared as Record<string, unknown>).lastError
          : undefined;
      return lastError == null && !isTerminalPersistedCompileRejection(shared);
    };
    const writeResumeHint = (
      executionId: ExecutionId,
      waitForWrite = false,
    ): Promise<void> | undefined => {
      if (!recoveryInputIsDurable || resumeHintWritten) return;
      resumeHintWritten = true;
      const hint = formatInterruptedResumeHint(
        runContext,
        executionId,
        'workflow',
        config.workingDirectory || runContext.cwd,
        recoveryProcessCwd,
      );
      return writeInterruptedResumeHint(hint, waitForWrite);
    };
    const maybeAdvertiseRecovery = (executionId: ExecutionId) =>
      Effect.gen(function* () {
        if (!execution.ok || !execution.outcomePersisted) return;
        const resumability = yield* deriveResumability(executionId, session);
        if (
          resumability.kind === 'checkpoint' &&
          canAdvertiseInterruptedExecution(resumability)
        ) {
          writeResumeHint(executionId);
        }
      });
    const execution = yield* executeCliConfig(config, runContext, {
      executionId: options.executionId,
      modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
      onInterruptedExecutionFinalized: recoveryInputIsDurable
        ? (executionId) => writeResumeHint(executionId, true)
        : undefined,
      canAdvertiseInterruptedExecution,
      expectedCategory: AgentCategory.Workflow,
      categoryMismatchMessage: options.categoryMismatchMessage,
      openWorkflowOutput: (result, tryCommitPublication) =>
        Effect.gen(function* () {
          const outputResult = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                resolveWorkflowOutput(output, outputDir, result, runContext, {
                  expectedOutputFiles,
                  tryCommitPublication,
                }),
              catch: ensureError,
            }),
          );
          let outcome = result.outcome;
          if (Result.isFailure(outputResult)) {
            workflowOutputError = outputResult.failure;
            if (outcome !== RUN_OUTCOME.CANCELLED) outcome = RUN_OUTCOME.FAILED;
          } else {
            workflowResult = outputResult.success;
          }
          yield* getExecutionRecords(
            session,
            result.executionId,
          ).writeResultMeta(
            buildCliWorkflowResultMeta(result, {
              outcome,
              copiedOutput: workflowResult?.copiedOutput,
              copiedOutputs: workflowResult?.copiedOutputs,
            }),
          );
          return outcome;
        }),
    });
    if (!execution.ok) return execution.exitCode;

    const { result } = execution;
    if (workflowOutputError !== undefined) {
      writeErrorStderr(workflowOutputError);
      if (result.outcome === RUN_OUTCOME.CANCELLED) {
        yield* maybeAdvertiseRecovery(result.executionId);
        return CliExitCode.Interrupted;
      }
      return CliExitCode.AgentError;
    }
    if (!workflowResult) {
      throw new Error(
        'Workflow output was not finalized before lease release.',
      );
    }

    // Output copying occurs while the run is still interruptible. Rebuild its
    // envelope from the lifecycle-resolved verdict so a signal that lands during
    // the copy cannot leave a completed presentation beside a cancelled run.
    workflowResult = { ...workflowResult, outcome: result.outcome };

    emitCliResult(runContext, {
      json: workflowResult,
      ndjson: { kind: 'result', result: workflowResult },
      text: formatWorkflowTextResult(workflowResult),
    });

    if (result.outcome === RUN_OUTCOME.CANCELLED) {
      yield* maybeAdvertiseRecovery(result.executionId);
    }

    return runOutcomeExitCode(result.outcome);
  },
);

export const runWorkflowCommand = defineCliCommand({
  meta: { name: 'run', description: 'Run a workflow agent' },
  args: {
    ...AGENT_RUN_GLOBAL_ARGS,
    agent: {
      type: 'positional',
      required: true,
      description: WORKFLOW_AGENT_NAME_DESCRIPTION,
    },
    input: {
      type: 'string',
      alias: 'i',
      required: true,
      valueHint: 'file',
      description:
        'Input file passed to the workflow agent (repeatable; use `-` to read stdin)',
    },
    context: {
      type: 'string',
      alias: 'c',
      valueHint: 'file',
      description:
        'Read-only context file passed to the workflow agent (repeatable; use `-` to read stdin)',
    },
    output: {
      type: 'string',
      valueHint: 'file',
      description:
        'Output file for a single-input run (use --output-dir for multi-input)',
    },
    'output-dir': {
      type: 'string',
      valueHint: 'directory',
      description: 'Directory to copy outputs into for multi-input runs',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Model for the agent',
    },
    instruction: {
      type: 'string',
      description: 'Instruction passed to the workflow agent',
    },
    'instruction-file': {
      type: 'string',
      valueHint: 'file',
      description:
        'File whose contents are passed before --instruction when both are set',
    },
  },
  run: async (context, ctx) => {
    const init = {
      agent: ctx.args.agent,
      ...collectCommonAgentRunFlags(ctx.rawArgs, ctx.args.instruction),
      output: optionalStringFlagValue(ctx.rawArgs, 'output'),
      outputDir: optionalStringFlagValue(ctx.rawArgs, 'output-dir'),
      model: optString(ctx.args.model),
    };
    await installCliProcessRuntime(context.storageRoot);
    return effectRuntime().runPromise(runWorkflowAgent(context, init));
  },
});
