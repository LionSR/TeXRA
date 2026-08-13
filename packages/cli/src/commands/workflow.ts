import * as path from 'node:path';

import { buildCliWorkflowResultMeta, getExecutionStore } from '@agent/storage';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { RUN_OUTCOME, type ExecutionId, AgentCategory } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  CliUsageError,
  readCliStdinText,
  readCliCwd,
  type CliContext,
} from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
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

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  cliProgressWriter,
  emitCliResult,
  writeCliProgressAndWait,
} from './_helpers/output';
import { formatResumeCommand } from '../chat/tui/state/resumeHint';
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
  isMaterializedStdinWorkflowInputPath,
  withExpandedRunInputs,
} from '../runtime/workflowInputs';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  type CliWorkflowRunResult,
  expectedOutputFilesForOutputDir,
  formatWorkflowTextResult,
  resolveWorkflowOutput,
} from '../runtime/workflowOutput';

const MULTI_INPUT_OUTPUT_MESSAGE =
  'Use --output-dir for multi-input workflow runs; --output is only for a single final artifact.';

function absoluteOutputDestination(
  destination: string | undefined,
  cwd: string,
): string | undefined {
  if (destination == null || destination.length === 0) return undefined;
  return path.isAbsolute(destination)
    ? destination
    : path.join(cwd, destination);
}

/** Read the launch directory without making recovery depend on its lifetime. */
function tryReadCliCwd(): string | undefined {
  try {
    return readCliCwd();
  } catch {
    return undefined;
  }
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

export async function runWorkflowAgent(
  context: CliContext,
  init: WorkflowRunInit,
): Promise<number> {
  if (init.output && init.outputDir) {
    throw new CliUsageError('Use either --output or --output-dir, not both.');
  }
  // Reject `--output-dir <path>` early when the path already points at a
  // non-directory (else we'd run the full workflow and EEXIST at the end).
  await assertOutputDirAvailable(init.outputDir, context.cwd);
  // Same fast-fail for `--output <path>`: existing directory or file-typed
  // parent component blows up at copy time (`EISDIR` / `EEXIST`) after the
  // full agent run otherwise.
  await assertOutputFileAvailable(init.output, context.cwd);
  const instruction = await resolveFileBackedInstruction(init, context.cwd);

  await initLocalCliPlatform(context);
  // Pre-validate the resolved agent so usage errors land before stdin is read
  // or the runtime host starts.
  const agent = await resolveCliLaunchAgent(init.agent, 'run');
  if (init.output && hasMixedStdinWorkflowInputSpecs(init.inputFiles)) {
    throw new CliUsageError(MULTI_INPUT_OUTPUT_MESSAGE);
  }

  return withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    context.cwd,
    { readStdinText: readCliStdinText },
    async ({ inputFiles, contextFiles }) => {
      if (init.output && inputFiles.length > 1) {
        throw new CliUsageError(MULTI_INPUT_OUTPUT_MESSAGE);
      }

      const model = await selectCliRunModel(context, init.model, 'run');
      const runContext = buildHeadlessRunContext(context);
      const expectedOutputFiles = init.outputDir
        ? expectedOutputFilesForOutputDir(agent, inputFiles)
        : undefined;
      const config: AgentConfigPayload = {
        agent: init.agent,
        model,
        inputFiles,
        contextFiles,
        outputFiles: [],
        // Persist CLI destinations absolutely so resumption has one path
        // representation and never reconstructs output locations.
        cliOutputFile: absoluteOutputDestination(init.output, runContext.cwd),
        cliOutputDirectory: absoluteOutputDestination(
          init.outputDir,
          runContext.cwd,
        ),
        cliExpectedOutputFiles: expectedOutputFiles
          ? [...expectedOutputFiles]
          : undefined,
        instruction,
        workingDirectory: runContext.cwd,
        agentCategory: AgentCategory.Workflow,
      };

      return executeCliWorkflowConfig(config, runContext, {
        registerExecution: true,
        categoryMismatchMessage: `Agent "${init.agent}" resolved to a non workflow run.`,
        output: init.output,
        outputDir: init.outputDir,
        expectedOutputFiles,
      });
    },
  );
}

/**
 * Execute a workflow config headless and surface its outputs: run through the
 * shared CLI execution skeleton, copy `--output`/`--output-dir` artifacts,
 * persist the result metadata, report an output failure back to the live run
 * lifecycle, emit the result in the requested format, and map the outcome to
 * an exit code. Shared by `texra run` (fresh runs) and `texra resume`
 * (workflow continuation under the persisted execution id).
 */
export async function executeCliWorkflowConfig(
  config: AgentConfigPayload,
  runContext: CliContext,
  options: {
    readonly registerExecution?: boolean;
    readonly categoryMismatchMessage: string;
    readonly output?: string;
    readonly outputDir?: string;
    readonly expectedOutputFiles?: readonly string[];
    readonly executionId?: ExecutionId;
    readonly modelHandlerCompatibilityKey?: CliConfigExecuteOptions['modelHandlerCompatibilityKey'];
  },
): Promise<number> {
  let workflowResult: CliWorkflowRunResult | undefined;
  let workflowOutputError: unknown;
  let resumeHintWritten = false;
  const recoveryProcessCwd = tryReadCliCwd();
  const recoveryInputIsDurable = [
    ...(config.inputFiles ?? []),
    ...(config.contextFiles ?? []),
  ].every((inputPath) => !isMaterializedStdinWorkflowInputPath(inputPath));
  const writeResumeHint = (
    executionId: ExecutionId,
    waitForWrite = false,
  ): Promise<void> | undefined => {
    if (!recoveryInputIsDurable) return;
    if (resumeHintWritten) return;
    resumeHintWritten = true;
    const hint = formatWorkflowResumeHint(
      runContext,
      executionId,
      config.workingDirectory || runContext.cwd,
      recoveryProcessCwd,
    );
    if (waitForWrite) return writeCliProgressAndWait(runContext, hint);
    cliProgressWriter(runContext)(hint);
  };
  const execution = await executeCliConfig(config, runContext, {
    enforceCategory: true,
    registerExecution: options.registerExecution,
    executionId: options.executionId,
    modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
    onInterruptedExecutionFinalized: recoveryInputIsDurable
      ? (executionId) => writeResumeHint(executionId, true)
      : undefined,
    expectedCategory: AgentCategory.Workflow,
    categoryMismatchMessage: options.categoryMismatchMessage,
    openWorkflowOutput: async (result) => {
      try {
        workflowResult = await resolveWorkflowOutput(
          options.output,
          options.outputDir,
          result,
          runContext,
          { expectedOutputFiles: options.expectedOutputFiles },
        );
      } catch (error) {
        workflowOutputError = error;
        return result.outcome === RUN_OUTCOME.CANCELLED
          ? result.outcome
          : RUN_OUTCOME.FAILED;
      }
    },
  });
  if (!execution.ok) return execution.exitCode;

  const { result } = execution;
  if (workflowOutputError !== undefined) {
    await persistWorkflowResultMeta(
      result.executionId,
      buildCliWorkflowResultMeta(result, {
        outcome: result.outcome,
      }),
    );
    writeErrorStderr(workflowOutputError);
    if (result.outcome === RUN_OUTCOME.CANCELLED) {
      if (execution.outcomePersisted) writeResumeHint(result.executionId);
      return CliExitCode.Interrupted;
    }
    return CliExitCode.AgentError;
  }
  if (!workflowResult) {
    throw new Error('Workflow output was not finalized before lease release.');
  }

  // Output copying occurs while the run is still interruptible. Rebuild its
  // envelope from the lifecycle-resolved verdict so a signal that lands during
  // the copy cannot leave a completed presentation beside a cancelled run.
  workflowResult = { ...workflowResult, outcome: result.outcome };
  await persistWorkflowResultMeta(
    result.executionId,
    buildCliWorkflowResultMeta(result, {
      outcome: result.outcome,
      copiedOutput: workflowResult.copiedOutput,
      copiedOutputs: workflowResult.copiedOutputs,
    }),
  );

  emitCliResult(runContext, {
    json: workflowResult,
    ndjson: { kind: 'result', result: workflowResult },
    text: formatWorkflowTextResult(workflowResult),
  });

  if (result.outcome === RUN_OUTCOME.CANCELLED) {
    if (execution.outcomePersisted) writeResumeHint(result.executionId);
  }

  return runOutcomeExitCode(result.outcome);
}

function formatWorkflowResumeHint(
  context: CliContext,
  executionId: string,
  workingDirectory: string,
  processCwd: string | undefined,
): string {
  const resumeCommand = formatResumeCommand(context.commandName, executionId, {
    cwd: workingDirectory,
    processCwd,
    approvalPolicy: context.approvalPolicy,
    outputFormat: context.outputFormat,
  });
  return `Resume this workflow with: ${resumeCommand}`;
}

async function persistWorkflowResultMeta(
  executionId: string,
  resultMeta: ReturnType<typeof buildCliWorkflowResultMeta>,
): Promise<void> {
  try {
    await getExecutionStore(executionId).writeResultMeta(resultMeta);
  } catch (error) {
    writeTextStderr(
      `Warning: could not persist workflow result metadata: ${toErrorMessage(error)}`,
    );
  }
}

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
  run: (context, ctx) =>
    runWorkflowAgent(context, {
      agent: ctx.args.agent,
      ...collectCommonAgentRunFlags(ctx.rawArgs, ctx.args.instruction),
      output: optionalStringFlagValue(ctx.rawArgs, 'output'),
      outputDir: optionalStringFlagValue(ctx.rawArgs, 'output-dir'),
      model: optString(ctx.args.model),
    }),
});
