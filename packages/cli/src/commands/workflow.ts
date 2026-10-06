import * as path from 'node:path';
import { Effect, FileSystem, Result } from 'effect';

import { deriveResumability, getRunRecords } from '@agent/storage';
import { type AgentConfigPayload, type SessionHandle } from '@agent/runtime';
import { DEFAULT_TOOL_CONFIG, RUN_OUTCOME, type RunId } from '@shared/schemas';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';

import {
  failUsage,
  readCliStdinText,
  type CliContext,
} from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import {
  advertisesInterruptedRun,
  type CheckpointRefinement,
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
import {
  initCliPlatform,
  type CliPlatformServices,
} from '../runtime/initPlatform';

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
  WORKFLOW_INPUT_REQUIRED_MESSAGE,
} from '../runtime/workflowInputs';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  type CliWorkflowRunResult,
  formatWorkflowTextResult,
  inputDerivedOutputFiles,
  resolveWorkflowOutput,
  resumeWorkflowOutputDirectory,
  resumeWorkflowOutputFile,
} from '../runtime/workflowOutput';
import type { SessionOpenError } from '@texra-ai/harness';

const MULTI_INPUT_OUTPUT_MESSAGE =
  'Use --output-dir for multi-input document tasks; --output is only for a single final artifact.';

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
  readonly reflect?: boolean;
}

/**
 * `texra run <agent>`: the one headless run command. The agent is resolved
 * once: one with a document task runs it over `--input` files (taking
 * `--output`/`--output-dir` and producing document artifacts); any other
 * takes a required instruction (`--instruction`, `--instruction-file`, or
 * both) and runs one model/tool cycle. Flags that belong to the other shape
 * are usage errors.
 */
export const runHeadlessAgent = Effect.fn('runHeadlessAgent')(function* (
  context: CliContext,
  init: HeadlessRunInit,
): Effect.fn.Return<number, Error, CliRunServices> {
  if (init.output && init.outputDir) {
    return yield* failUsage('Use either --output or --output-dir, not both.');
  }
  const instruction = yield* resolveFileBackedInstruction(init, context.cwd);
  // Nothing can run this: a document task needs at least one input file, a
  // chat needs an instruction. Rejecting it before the
  // platform init keeps a plain usage error off the agent-catalog fetch a
  // signed-in session would otherwise pay for.
  if (!instruction && init.inputFiles.length === 0) {
    return yield* failUsage(
      'Provide --instruction or --instruction-file for an agent, or --input for a document task.',
    );
  }

  const services = yield* initCliPlatform(context);
  // Resolve once, before stdin is read or the runtime host starts; the run
  // pins the resolved source.
  const { task, source } = yield* resolveCliRunAgent(services, init.agent);
  if (task === null) {
    return yield* runToolUseAgent(context, init, source, instruction, services);
  }

  // A document task with no `--input` cannot run, and the output probes below
  // `mkdir -p` their destination before `withExpandedRunInputs` would report
  // it. Refuse first so an invalid command leaves nothing on disk.
  if (init.inputFiles.length === 0) {
    return yield* failUsage(WORKFLOW_INPUT_REQUIRED_MESSAGE);
  }
  // Fast-fail an `--output-dir` or `--output` path the final copy would reject
  // (`EEXIST` / `EISDIR`) only after the full agent run.
  yield* assertOutputDirAvailable(init.outputDir, context.cwd);
  yield* assertOutputFileAvailable(init.output, context.cwd);
  if (init.output && hasMixedStdinWorkflowInputSpecs(init.inputFiles)) {
    return yield* failUsage(MULTI_INPUT_OUTPUT_MESSAGE);
  }

  return yield* withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    context.cwd,
    { readStdinText: readCliStdinText },
    ({ inputFiles, contextFiles, stdinInputPath }) =>
      Effect.gen(function* () {
        if (init.output && inputFiles.length > 1) {
          return yield* failUsage(MULTI_INPUT_OUTPUT_MESSAGE);
        }

        const model = yield* selectCliRunModel(
          context,
          init.model,
          'run',
          services,
        );
        const runContext = buildHeadlessRunContext(context);
        // Only the input-derived names are knowable here: the agent's declared
        // defaults live in a definition the launch below loads, and loading it
        // twice could observe a different revision than the run executes. They are applied at finalization.
        const expectedOutputFiles = init.outputDir
          ? inputDerivedOutputFiles(inputFiles, stdinInputPath)
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
        const config: AgentConfigPayload = documentTaskConfig({
          agent: init.agent,
          agentSource: source,
          model,
          inputFiles,
          contextFiles,
          outputFiles: [],
          ...(init.reflect && {
            toolConfig: { ...DEFAULT_TOOL_CONFIG, reflect: true },
          }),
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
        });

        return yield* executeCliWorkflowConfig(config, runContext, {
          session: services.session,
          runtime: services.runtime,
          shutdownScope: services.shutdownScope,
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
  agentSource: AgentConfigPayload['agentSource'],
  instruction: string,
  services: CliPlatformServices,
): Effect.fn.Return<number, Error, CliRunServices> {
  // `--output` and `--output-dir` are rejected as a pair before this point, so
  // at most one of them is set here.
  const workflowOnlyFlag =
    (init.output && '--output') ||
    (init.outputDir && '--output-dir') ||
    (init.reflect && '--reflect');
  if (workflowOnlyFlag) {
    return yield* failUsage(
      `${workflowOnlyFlag} is only available for document tasks; "${init.agent}" has no task.`,
    );
  }
  if (!instruction) {
    return yield* failUsage('Provide --instruction or --instruction-file.');
  }

  const model = yield* selectCliRunModel(context, init.model, 'chat', services);
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
          agentSource,
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
        };

        const run = yield* executeCliToolUseConfig(config, runContext, {
          session: services.session,
          runtime: services.runtime,
          shutdownScope: services.shutdownScope,
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
      /** The process session the run executes under: `initCliPlatform`'s one
       *  memoized open. */
      readonly session: Effect.Effect<SessionHandle, SessionOpenError>;
      /** The process runtime the shared skeleton runs its Promise-edge
       *  callbacks on, from the same services. */
      readonly runtime: CliConfigExecuteOptions['runtime'];
      /** The host's shutdown registry, from the same services. */
      readonly shutdownScope: CliConfigExecuteOptions['shutdownScope'];
      readonly recoveryInputIsDurable?: boolean;
      readonly runId?: RunId;
      readonly agentRuns?: CliConfigExecuteOptions['agentRuns'];
    },
  ): Effect.fn.Return<number, Error, CliRunServices> {
    const session = yield* options.session;
    const fileSystem = yield* FileSystem.FileSystem;
    let workflowResult: CliWorkflowRunResult | undefined;
    let workflowOutputError: unknown;
    let resumeHintWritten = false;
    // The persisted `cli` block is the single representation of where this run
    // writes; never take the destinations a second time as call options.
    const output = resumeWorkflowOutputFile(config);
    const outputDir = resumeWorkflowOutputDirectory(config);
    const recoveryProcessCwd = tryReadCliCwd();
    const recoveryInputIsDurable = options.recoveryInputIsDurable ?? true;
    // Not a run a model failure stopped (its folded `lastError`): read from
    // the rows, so no verdict held in memory can be missed by an interrupt.
    const canAdvertiseInterruptedRun: CheckpointRefinement = (_, runId) =>
      Effect.map(
        session.runHistory.load(runId),
        (state) => state?.lastError == null,
      );
    const writeResumeHint = (
      runId: RunId,
      waitForWrite = false,
    ): Effect.Effect<void> => {
      if (!recoveryInputIsDurable || resumeHintWritten) return Effect.void;
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
          yield* advertisesInterruptedRun(
            runId,
            resumability,
            canAdvertiseInterruptedRun,
          )
        )
          yield* writeResumeHint(runId);
      });
    const run = yield* executeCliConfig(config, runContext, {
      session: options.session,
      runtime: options.runtime,
      shutdownScope: options.shutdownScope,
      runId: options.runId,
      agentRuns: options.agentRuns,
      onInterruptedRunFinalized: recoveryInputIsDurable
        ? (runId) => writeResumeHint(runId, true)
        : undefined,
      canAdvertiseInterruptedRun,
      publishWorkflowOutput: (
        result,
        agentDefaultOutputFiles,
        tryCommitPublication,
      ) =>
        Effect.gen(function* () {
          // Handed over by the launch (the only load of this run's definition):
          // the defaults this run actually executed, not a reread of a catalog
          // entry a nested refresh may have swapped since. The input-derived `cli.expectedOutputFiles` the
          // launch computed stand in when the agent declares none.
          const declaredOutputFiles = agentDefaultOutputFiles.filter(Boolean);
          const expectedOutputFiles = declaredOutputFiles.length
            ? declaredOutputFiles
            : (config.cli?.expectedOutputFiles ?? undefined);
          const outputResult = yield* Effect.result(
            resolveWorkflowOutput(output, outputDir, result, runContext, {
              expectedOutputFiles,
              storageRoot: session.roots.storage,
              tryCommitPublication,
            }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
          );
          if (Result.isFailure(outputResult)) {
            workflowOutputError = outputResult.failure;
          } else {
            workflowResult = outputResult.success;
          }
          yield* getRunRecords(session, result.runId).writeResultMeta({
            producer: 'cliWorkflow',
            output: workflowResult?.output ?? result.output,
            ...(workflowResult?.copiedOutput !== undefined && {
              copiedOutput: workflowResult.copiedOutput,
            }),
            ...(workflowResult?.copiedOutputs !== undefined && {
              copiedOutputs: [...workflowResult.copiedOutputs],
            }),
          });
          // The fact the run decides its verdict from; the run, not this
          // host, commits the outcome.
          return Result.isFailure(outputResult) ? 'failed' : 'published';
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
      return yield* Effect.die(
        new Error(
          'Document task output was not finalized before the run ended.',
        ),
      );
    }

    // Copying runs while the run is interruptible, so the envelope takes the
    // lifecycle-resolved verdict (a signal during the copy must not leave a
    // completed presentation) and the invocation's own fields, its plugins.
    workflowResult = { ...result, ...workflowResult, outcome: result.outcome };

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
        'Workspace file passed to the agent (repeatable; use `-` to read stdin; required for document tasks)',
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
        'Document tasks only: output file for a single-input run (use --output-dir for multi-input)',
    },
    'output-dir': {
      type: 'string',
      valueHint: 'directory',
      description:
        'Document tasks only: directory to copy outputs into for multi-input runs',
    },
    model: {
      type: 'string',
      alias: 'm',
      description: 'Model for the agent',
    },
    instruction: {
      type: 'string',
      description:
        'Instruction passed to the agent (a run that is no document task needs this or --instruction-file)',
    },
    'instruction-file': {
      type: 'string',
      valueHint: 'file',
      description:
        'File whose contents are passed before --instruction when both are set',
    },
    reflect: {
      type: 'boolean',
      description:
        'Document tasks only: have the critic agent review each revision but the last',
    },
  },
  run: (context, ctx) =>
    runHeadlessAgent(context, {
      agent: ctx.args.agent,
      ...collectCommonAgentRunFlags(ctx.rawArgs, ctx.args.instruction),
      output: optionalStringFlagValue(ctx.rawArgs, 'output'),
      outputDir: optionalStringFlagValue(ctx.rawArgs, 'output-dir'),
      model: optString(ctx.args.model),
      reflect: ctx.args.reflect === true,
    }),
});
