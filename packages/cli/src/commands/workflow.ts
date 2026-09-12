import * as path from 'node:path';
import { Effect, Result } from 'effect';

import {
  buildCliWorkflowResultMeta,
  deriveResumability,
  getRunRecords,
  type ResumabilityDecision,
} from '@agent/storage';
import { type AgentConfigPayload } from '@agent/runtime';
import { AppState } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import { Secrets } from '@platform/secrets';
import { RUN_OUTCOME, type RunId, AgentCategory } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import { initializeCliTranscriptSession } from '../runtime/transcriptSession';
import { snapshotHoldsTerminalCompileRejection } from '../runtime/toolUseResumeData';

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
import { writeErrorStderr } from '../runtime/logSinks';
import {
  buildHeadlessRunContext,
  selectCliRunModel,
} from '../runtime/runModel';
import {
  LAUNCHABLE_AGENT_NAME_DESCRIPTION,
  resolveCliRunAgent,
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
  executeCliToolUseConfig,
  type CliConfigExecuteOptions,
  type CliRunServices,
} from '../runtime/executeCli';
import { formatToolUseAgentRunInstruction } from './_helpers/runInstructions';
import {
  runOutcomeExitCode,
  toolUseResultText,
} from '../runtime/terminalStatus';
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

interface HeadlessRunInit {
  readonly agent: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly output?: string;
  readonly outputDir?: string;
  readonly model?: string;
  readonly instruction: string;
  readonly instructionFile?: string;
}

/**
 * `texra run <agent>`: the one headless run command, for both agent
 * categories. The agent is resolved once and its category picks the run shape —
 * a workflow agent takes `--output`/`--output-dir` and produces document
 * artifacts, a tool-use agent takes a required instruction (`--instruction`,
 * `--instruction-file`, or both) and runs one model/tool cycle. Flags that
 * belong to the other category are usage errors.
 */
export const runHeadlessAgent = Effect.fn('runHeadlessAgent')(function* (
  context: CliContext,
  init: HeadlessRunInit,
): Effect.fn.Return<number, Error, CliRunServices> {
  if (init.output && init.outputDir) {
    throw new CliUsageError('Use either --output or --output-dir, not both.');
  }
  const instruction = yield* Effect.tryPromise({
    try: () => resolveFileBackedInstruction(init, context.cwd),
    catch: ensureError,
  });
  // Neither category can run this: a workflow agent needs at least one input
  // file, a tool-use agent needs an instruction. Rejecting it before the
  // platform init keeps a plain usage error off the agent-catalog fetch a
  // signed-in session would otherwise pay for.
  if (!instruction && init.inputFiles.length === 0) {
    throw new CliUsageError(
      'Provide --instruction or --instruction-file for a tool-use agent, or --input for a workflow agent.',
    );
  }

  const services = yield* Effect.tryPromise({
    try: () => initLocalCliPlatform(context),
    catch: ensureError,
  });
  // Pre-validate the resolved agent so usage errors land before stdin is read
  // or the runtime host starts.
  const agent = yield* Effect.tryPromise({
    try: () => resolveCliRunAgent(init.agent),
    catch: ensureError,
  });
  if (agent.category === AgentCategory.ToolUse) {
    return yield* runToolUseAgent(context, init, instruction, services);
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
          try: () => selectCliRunModel(context, init.model, 'run', services),
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
          recoveryInputIsDurable: stdinInputPath === undefined,
        });
      }),
  );
});

/**
 * The tool-use half of `texra run`: one model/tool cycle over the named
 * workspace files, reported as the agent's final response.
 */
const runToolUseAgent = Effect.fn('runToolUseAgent')(function* (
  context: CliContext,
  init: HeadlessRunInit,
  instruction: string,
  services: Parameters<typeof selectCliRunModel>[3],
): Effect.fn.Return<number, Error, CliRunServices> {
  // `--output` and `--output-dir` are rejected as a pair before this point, so
  // at most one of them is set here.
  const workflowOnlyFlag = init.output
    ? '--output'
    : init.outputDir && '--output-dir';
  if (workflowOnlyFlag) {
    throw new CliUsageError(
      `${workflowOnlyFlag} is only available for workflow agents; "${init.agent}" is a ${AgentCategory.ToolUse} agent.`,
    );
  }
  if (!instruction) {
    throw new CliUsageError('Provide --instruction or --instruction-file.');
  }

  const model = yield* Effect.tryPromise({
    try: () => selectCliRunModel(context, init.model, 'chat', services),
    catch: ensureError,
  });
  const runContext = buildHeadlessRunContext(context);

  return yield* withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    runContext.cwd,
    {
      allowEmptyInput: true,
      requireWorkspaceFiles: true,
      readStdinText: readCliStdinText,
    },
    ({ inputFiles, contextFiles, stdinInputPath }) =>
      Effect.gen(function* () {
        const config: AgentConfigPayload = {
          agent: init.agent,
          model,
          inputFiles,
          contextFiles,
          instruction: formatToolUseAgentRunInstruction({
            inputFiles,
            contextFiles,
            instruction,
          }),
          displayInstruction: instruction,
          workingDirectory: runContext.cwd,
          agentCategory: AgentCategory.ToolUse,
        };

        const run = yield* executeCliToolUseConfig(config, runContext, {
          stopAfterCycle: true,
          recoveryInputIsDurable: stdinInputPath === undefined,
        });
        if (!run.ok) return run.exitCode;

        emitCliResult(runContext, {
          json: run.result,
          ndjson: { kind: 'agent-result', result: run.result },
          text: toolUseResultText(run.result),
        });

        return run.exitCode;
      }),
  );
});

/**
 * Execute a workflow config headless and surface its outputs: run through the
 * shared CLI run skeleton, copy `--output`/`--output-dir` artifacts,
 * persist the result metadata, report an output failure back to the live run
 * lifecycle, emit the result in the requested format, and map the outcome to
 * an exit code. Shared by `texra run` (fresh runs) and `texra resume`
 * (workflow continuation under the persisted run id).
 */
export const executeCliWorkflowConfig = Effect.fn('executeCliWorkflowConfig')(
  function* (
    config: AgentConfigPayload,
    runContext: CliContext,
    options: {
      readonly recoveryInputIsDurable?: boolean;
      readonly runId?: RunId;
      readonly modelCompatibilityKey?: CliConfigExecuteOptions['modelCompatibilityKey'];
    },
  ): Effect.fn.Return<number, Error, CliRunServices> {
    const stores = { secrets: yield* Secrets, globalState: yield* AppState };
    const session = yield* Effect.tryPromise({
      try: () => initializeCliTranscriptSession(stores),
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
    const canAdvertiseInterruptedRun = (
      resumability: Extract<ResumabilityDecision, { kind: 'checkpoint' }>,
    ): boolean => {
      // Only a reflection run reaches here — this is the workflow command.
      // The two facts the hint turns on sit in different halves of the
      // snapshot: the model failure is runtime-owned (`runtime.lastError`,
      // the single durable location, written with the waiting/deny
      // snapshots), the compile rejection is family state.
      const { snapshot } = resumability;
      if (snapshot.family !== 'reflection') return false;
      return (
        snapshot.runtime.lastError == null &&
        !snapshotHoldsTerminalCompileRejection(snapshot)
      );
    };
    const writeResumeHint = (
      runId: RunId,
      waitForWrite = false,
    ): Promise<void> | undefined => {
      if (!recoveryInputIsDurable || resumeHintWritten) return;
      resumeHintWritten = true;
      const hint = formatInterruptedResumeHint(
        runContext,
        runId,
        'workflow',
        config.workingDirectory || runContext.cwd,
        recoveryProcessCwd,
      );
      return writeInterruptedResumeHint(hint, waitForWrite);
    };
    const maybeAdvertiseRecovery = (runId: RunId) =>
      Effect.gen(function* () {
        if (!run.ok || !run.outcomePersisted) return;
        const resumability = yield* deriveResumability(runId, session);
        if (
          resumability.kind === 'checkpoint' &&
          canAdvertiseInterruptedRun(resumability)
        ) {
          writeResumeHint(runId);
        }
      });
    const run = yield* executeCliConfig(config, runContext, {
      runId: options.runId,
      modelCompatibilityKey: options.modelCompatibilityKey,
      onInterruptedRunFinalized: recoveryInputIsDurable
        ? (runId) => writeResumeHint(runId, true)
        : undefined,
      canAdvertiseInterruptedRun,
      expectedCategory: AgentCategory.Workflow,
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
          yield* getRunRecords(session, result.runId).writeResultMeta(
            buildCliWorkflowResultMeta(result, {
              copiedOutput: workflowResult?.copiedOutput,
              copiedOutputs: workflowResult?.copiedOutputs,
            }),
          );
          return outcome;
        }),
    });
    if (!run.ok) return run.exitCode;

    const { result } = run;
    if (workflowOutputError !== undefined) {
      writeErrorStderr(workflowOutputError);
      if (result.outcome === RUN_OUTCOME.CANCELLED) {
        yield* maybeAdvertiseRecovery(result.runId);
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
      yield* maybeAdvertiseRecovery(result.runId);
    }

    return runOutcomeExitCode(result.outcome);
  },
);

export const headlessRunCommand = defineCliCommand({
  meta: { name: 'run', description: 'Run an agent headlessly' },
  args: {
    ...AGENT_RUN_GLOBAL_ARGS,
    agent: {
      type: 'positional',
      required: true,
      description: LAUNCHABLE_AGENT_NAME_DESCRIPTION,
    },
    input: {
      type: 'string',
      alias: 'i',
      valueHint: 'file',
      description:
        'Workspace file passed to the agent (repeatable; use `-` to read stdin; required for workflow agents)',
    },
    context: {
      type: 'string',
      alias: 'c',
      valueHint: 'file',
      description:
        'Read-only context file passed to the agent (repeatable; use `-` to read stdin)',
    },
    output: {
      type: 'string',
      valueHint: 'file',
      description:
        'Workflow agents only: output file for a single-input run (use --output-dir for multi-input)',
    },
    'output-dir': {
      type: 'string',
      valueHint: 'directory',
      description:
        'Workflow agents only: directory to copy outputs into for multi-input runs',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Model for the agent',
    },
    instruction: {
      type: 'string',
      description:
        'Instruction passed to the agent (tool-use agents need this or --instruction-file)',
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
    return effectRuntime().runPromise(runHeadlessAgent(context, init));
  },
});
