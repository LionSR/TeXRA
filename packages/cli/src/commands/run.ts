import * as path from 'node:path';
import { Effect, FileSystem, Option, Result } from 'effect';
import { Argument, Flag } from 'effect/cli';

import {
  toErrorMessage,
  RUN_OUTCOME,
  type RunId,
} from '@texra-ai/harness/schemas';
import type { CliDocumentTaskResult } from '@cli/schemas/cliOutput';
import { documentsOf } from '@texra/shared/plugins/documents';

import {
  failUsage,
  type CliContext,
  type CliInvocation,
} from '../runtime/platform/cliContext';
import { CliExitCode } from '../runtime/platform/exitCodes';
import {
  writeErrorStderr,
  writeTextStderr,
} from '../runtime/platform/logSinks';
import { selectCliRunModel } from '../runtime/models/runModel';
import {
  RUN_TARGET_NAME_DESCRIPTION,
  missingRunTargetMessage,
  resolveCliRunAgent,
} from '../runtime/agents';
import {
  cliPlatform,
  type CliPlatform,
  type CliPlatformServices,
} from '../runtime/platform/initPlatform';

import {
  cliCommand,
  modelFlag,
  SKILL_SOURCES_CONFIG,
} from './_helpers/cliCommand';
import { emitCliResult } from './_helpers/output';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import {
  executeCliConfig,
  type CliExecuteOptions,
} from '../runtime/headless/executeCli';
import { formatToolUseAgentRunInstruction } from './_helpers/runInstructions';
import {
  runOutcomeExitCode,
  toolUseResultText,
} from '../runtime/headless/terminalStatus';
import {
  hasMixedStdinDocumentTaskInputSpecs,
  withExpandedRunInputs,
  DOCUMENT_TASK_INPUT_REQUIRED_MESSAGE,
} from '../runtime/headless/documentTaskInputs';
import {
  isTaskFileGlob,
  splitMediaFiles,
} from '@texra/controllers/session/taskFiles';
import { inputDerivedOutputFiles } from '@texra/controllers/progressView/documentTaskOutputs';
import {
  assertOutputDestinationAvailable,
  cliLaunchOutput,
  formatDocumentTaskTextResult,
  resolveDocumentTaskOutput,
  resumeDocumentTaskOutputDirectory,
  resumeDocumentTaskOutputFile,
} from '../runtime/headless/documentTaskOutput';
import type { Sessions } from '@texra-ai/harness';
import { TaskRecordsFailed } from '@texra/controllers/server/protocol';
import {
  programLaunch,
  programsNow,
  type ProcessServices,
} from '@texra-ai/harness/host';
import type { AgentConfigPayload } from '@texra-ai/harness/schemas';

const MULTI_INPUT_OUTPUT_MESSAGE =
  'Use --output-dir for a program over several inputs; --output is only for a single final artifact.';

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
 * `texra run <program | agent>`: the one headless run command. A name a
 * plugin registers as a program runs that program over `--input` files
 * (taking `--output`/`--output-dir` and producing document artifacts); any
 * other name is an agent's, which takes a required instruction
 * (`--instruction`, `--instruction-file`, or both) and runs one model/tool
 * cycle. Flags that belong to the other shape are usage errors.
 */
export const runHeadlessAgent = Effect.fn('runHeadlessAgent')(function* (
  context: CliContext,
  init: HeadlessRunInit,
): Effect.fn.Return<
  number,
  Error,
  ProcessServices | Sessions | CliPlatform | CliInvocation
> {
  if (init.output && init.outputDir) {
    return yield* failUsage('Use either --output or --output-dir, not both.');
  }
  const instruction = yield* resolveFileBackedInstruction(init, context.cwd);
  // Nothing can run this: a program needs at least one input file, a chat
  // needs an instruction. Rejecting it before the
  // platform init keeps a plain usage error cheap.
  if (!instruction && init.inputFiles.length === 0) {
    return yield* failUsage(
      'Provide --instruction or --instruction-file for an agent, or --input for a program.',
    );
  }

  const services = yield* cliPlatform;
  const { programs, withheld } = yield* programsNow();
  const program = programs.get(init.agent);
  // An installed plugin names its agents and its programs `<plugin>:<name>`
  // alike: a name that is both is refused rather than one picked unsaid.
  if (program !== undefined && init.agent.includes(':')) {
    const agent = yield* Effect.result(
      resolveCliRunAgent(services, init.agent),
    );
    if (Result.isSuccess(agent))
      return yield* failUsage(
        `${init.agent} names both a program and an agent of its plugin; rename one of them in the plugin.`,
      );
  }
  if (program === undefined) {
    // Resolve once, before stdin is read or the runtime host starts; the
    // run pins the resolved source.
    const { source } = yield* resolveCliRunAgent(
      services,
      init.agent,
      // `<plugin>:<name>` may be a program its plugin does not load now.
      [
        missingRunTargetMessage(init.agent, [...programs.keys()]),
        ...(init.agent.includes(':') ? withheld : []),
      ].join(' '),
    );
    return yield* runToolUseAgent(
      context,
      init,
      { kind: source },
      instruction,
      services,
    );
  }

  // A program with no `--input` cannot run, and the output probes below
  // `mkdir -p` their destination before `withExpandedRunInputs` would report
  // it. Refuse first so an invalid command leaves nothing on disk.
  if (init.inputFiles.length === 0) {
    return yield* failUsage(DOCUMENT_TASK_INPUT_REQUIRED_MESSAGE);
  }
  if (init.output && (program.outputs ?? []).length > 1) {
    return yield* failUsage(MULTI_INPUT_OUTPUT_MESSAGE);
  }
  // Fast-fail an `--output-dir` or `--output` path the final copy would reject
  // (`EEXIST` / `EISDIR`) only after the full agent run.
  yield* assertOutputDestinationAvailable(
    'directory',
    init.outputDir,
    context.cwd,
  );
  yield* assertOutputDestinationAvailable('file', init.output, context.cwd);
  if (init.output) {
    // Only literal text specs can be rejected before expanding globs or
    // reading stdin. The expanded files are checked below.
    const literalInputs = init.inputFiles
      .map((file) => file.trim())
      .filter((file) => !isTaskFileGlob(file));
    if (
      hasMixedStdinDocumentTaskInputSpecs(
        splitMediaFiles(literalInputs).inputFiles,
      )
    ) {
      return yield* failUsage(MULTI_INPUT_OUTPUT_MESSAGE);
    }
  }

  return yield* withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    context.cwd,
    'program',
    Effect.fnUntraced(function* ({
      inputFiles,
      mediaFiles,
      contextFiles,
      writtenFiles,
    }) {
      if (init.output && inputFiles.length > 1) {
        return yield* failUsage(MULTI_INPUT_OUTPUT_MESSAGE);
      }

      const model = yield* selectCliRunModel(
        context,
        init.model,
        'run',
        services,
      );
      // Only the input-derived names: the program's own outputs are stamped
      // on the config below, and read back from the recorded config at
      // finalization.
      const expectedOutputFiles = init.outputDir
        ? inputDerivedOutputFiles(inputFiles, writtenFiles)
        : undefined;
      // Persist CLI destinations absolutely so resumption has one path
      // representation and never reconstructs output locations.
      const cliOutputFile = init.output
        ? path.resolve(context.cwd, init.output)
        : undefined;
      const cliOutputDirectory = init.outputDir
        ? path.resolve(context.cwd, init.outputDir)
        : undefined;
      const launch = {
        model,
        inputFiles,
        mediaFiles,
        contextFiles,
        outputFiles: [],
        ...(cliOutputFile !== undefined || cliOutputDirectory !== undefined
          ? {
              launch: {
                ...(cliOutputFile !== undefined && {
                  outputFile: cliOutputFile,
                }),
                ...(cliOutputDirectory !== undefined && {
                  outputDirectory: cliOutputDirectory,
                }),
                ...(expectedOutputFiles && {
                  expectedOutputFiles: [...expectedOutputFiles],
                }),
              },
            }
          : {}),
        instruction,
        workingDirectory: context.cwd,
      };
      const config: AgentConfigPayload = {
        ...launch,
        ...(yield* programLaunch(init.agent, {}, launch)),
      };

      return yield* executeCliRun(config, context, {
        services,
        recoveryInputIsDurable: writtenFiles.length === 0,
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
): Effect.fn.Return<number, Error, ProcessServices | CliInvocation> {
  // `--output` and `--output-dir` are rejected as a pair before this point, so
  // at most one of them is set here.
  const programOnlyFlag =
    (init.output && '--output') || (init.outputDir && '--output-dir');
  if (programOnlyFlag) {
    return yield* failUsage(
      `${programOnlyFlag} is only available for programs; "${init.agent}" is an agent.`,
    );
  }
  if (!instruction) {
    return yield* failUsage('Provide --instruction or --instruction-file.');
  }

  const model = yield* selectCliRunModel(context, init.model, 'chat', services);

  return yield* withExpandedRunInputs(
    init.inputFiles,
    init.contextFiles,
    context.cwd,
    'agent',
    Effect.fnUntraced(function* ({
      inputFiles,
      mediaFiles,
      contextFiles,
      writtenFiles,
    }) {
      const config: AgentConfigPayload = {
        agent: init.agent,
        agentSource,
        model,
        inputFiles,
        mediaFiles,
        contextFiles,
        instruction: formatToolUseAgentRunInstruction({
          inputFiles,
          contextFiles,
          instruction,
        }),
        displayInstruction: instruction,
        workingDirectory: context.cwd,
      };

      const run = yield* executeCliConfig(config, context, {
        services,
        recoveryInputIsDurable: writtenFiles.length === 0,
      });
      if (!run.ok) return run.exitCode;

      yield* emitCliResult({
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
 * persist the result metadata once the run's end commits, emit the result in
 * the requested format, and map the outcome (or a failed copy) to
 * an exit code. Shared by `texra run` (fresh runs) and `texra resume`
 * (workflow continuation under the persisted run id).
 */
export const executeCliRun = Effect.fn('executeCliRun')(function* (
  config: AgentConfigPayload,
  runContext: CliContext,
  options: {
    readonly services: CliExecuteOptions['services'];
    /** False when invocation-owned temporary inputs will not survive exit. */
    readonly recoveryInputIsDurable: boolean;
    readonly runId?: RunId;
  },
): Effect.fn.Return<number, Error, ProcessServices | CliInvocation> {
  const session = yield* options.services.session;
  const fileSystem = yield* FileSystem.FileSystem;
  let documentTaskResult: CliDocumentTaskResult | undefined;
  let documentTaskOutputError: unknown;
  // The persisted `cli` block is the single representation of where this run
  // writes; never take the destinations a second time as call options.
  const output = resumeDocumentTaskOutputFile(config);
  const outputDir = resumeDocumentTaskOutputDirectory(config);
  const run = yield* executeCliConfig(config, runContext, {
    services: options.services,
    runId: options.runId,
    recoveryInputIsDurable: options.recoveryInputIsDurable,
    // The run's output is published after its end commits, gated on that
    // committed outcome (`resolveDocumentTaskOutput` copies only a completed
    // run's): output that cannot be written fails this command, never the
    // recorded run. Inside the finalization a shutdown waits for.
    afterRun: Effect.fn('workflow.afterRun')(function* (ended) {
      // The defaults the run executed, as its recorded configuration
      // states them (the launch resolves an empty output list to the
      // program's own, `Program.outputs`); the input-derived
      // `cli.expectedOutputFiles` stand in when the program declares none.
      // A configuration that does not read leaves the copy undone: that
      // fails the command when a completed run's copy was asked for, and
      // only warns otherwise.
      const recorded = yield* Effect.result(
        session.records(ended.runId).readConfig,
      );
      if (Result.isFailure(recorded)) {
        const message = `The output of task ${ended.runId} was not copied: its recorded configuration could not be read: ${toErrorMessage(recorded.failure)}`;
        if ((output || outputDir) && ended.outcome === RUN_OUTCOME.COMPLETED)
          documentTaskOutputError = new TaskRecordsFailed({
            runId: ended.runId,
            message,
          });
        else writeTextStderr(`[warn] ${message}`);
      }
      const copied = Result.isSuccess(recorded);
      const declaredOutputFiles = copied
        ? (recorded.success?.outputFiles ?? []).filter(Boolean)
        : [];
      const expectedOutputFiles = declaredOutputFiles.length
        ? declaredOutputFiles
        : (cliLaunchOutput(config).expectedOutputFiles ?? undefined);
      // The task's documents are its documents row, read from the
      // store, which holds every row the run committed once its end is.
      const outputResult = yield* Effect.result(
        session.view.read([]).pipe(
          Effect.mapError(
            (cause) =>
              new TaskRecordsFailed({
                runId: ended.runId,
                message: `The documents of task ${ended.runId} could not be read: ${toErrorMessage(cause)}`,
              }),
          ),
          Effect.flatMap((stored) => {
            const run = stored.runs.get(ended.runId);
            return resolveDocumentTaskOutput(
              copied ? output : undefined,
              copied ? outputDir : undefined,
              ended,
              run && documentsOf(run),
              runContext,
              { expectedOutputFiles, storageRoot: session.roots.storage },
            );
          }),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ),
      );
      if (Result.isFailure(outputResult)) {
        documentTaskOutputError ??= outputResult.failure;
      } else {
        documentTaskResult = outputResult.success;
      }
    }),
  });
  if (!run.ok) return run.exitCode;

  const { result } = run;
  if (documentTaskOutputError !== undefined) {
    writeErrorStderr(documentTaskOutputError);
    return result.outcome === RUN_OUTCOME.CANCELLED
      ? CliExitCode.Interrupted
      : CliExitCode.AgentError;
  }
  if (!documentTaskResult) {
    return yield* Effect.die(
      new Error('Program output was not finalized before the run ended.'),
    );
  }

  yield* emitCliResult({
    json: documentTaskResult,
    ndjson: { kind: 'result', result: documentTaskResult },
    text: formatDocumentTaskTextResult(documentTaskResult),
  });

  return runOutcomeExitCode(result.outcome);
});

const fileFlag = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withMetavar('file'),
    Flag.withDescription(description),
  );

export const headlessRunCommand = cliCommand('run', {
  description: 'Run a program or an agent headlessly',
  config: {
    ...SKILL_SOURCES_CONFIG,
    target: Argument.String('target').pipe(
      Argument.withDescription(RUN_TARGET_NAME_DESCRIPTION),
    ),
    input: fileFlag(
      'input',
      'Text or supported media file passed to the agent (repeatable; use `-` for text stdin; required for programs)',
    ).pipe(Flag.withAlias('i'), Flag.atLeast(0)),
    context: fileFlag(
      'context',
      'Read-only context file passed to the agent (repeatable; use `-` to read stdin)',
    ).pipe(Flag.withAlias('c'), Flag.atLeast(0)),
    output: fileFlag(
      'output',
      'Programs only: output file for a single-input run (use --output-dir for multi-input)',
    ).pipe(Flag.optional),
    outputDir: Flag.String('output-dir').pipe(
      Flag.withMetavar('directory'),
      Flag.withDescription(
        'Programs only: directory to copy outputs into for multi-input runs',
      ),
      Flag.optional,
    ),
    model: modelFlag('Model for the agent'),
    instruction: Flag.String('instruction').pipe(
      Flag.withDescription(
        'Instruction passed to the agent or program (an agent needs this or --instruction-file)',
      ),
      Flag.optional,
    ),
    instructionFile: fileFlag(
      'instruction-file',
      'File whose contents are passed before --instruction when both are set',
    ).pipe(Flag.optional),
  },
  run: (context, input) =>
    runHeadlessAgent(context, {
      agent: input.target,
      inputFiles: [...input.input],
      contextFiles: [...input.context],
      instruction: Option.getOrElse(input.instruction, () => ''),
      instructionFile: Option.getOrUndefined(input.instructionFile),
      output: Option.getOrUndefined(input.output),
      outputDir: Option.getOrUndefined(input.outputDir),
      model: Option.getOrUndefined(input.model),
    }),
});
