import * as path from 'node:path';

import { writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { EXECUTION_STATUS } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';

import {
  CliUsageError,
  readCliStdinText,
  type CliContext,
} from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { writeErrorStderr } from '../runtime/logSinks';
import {
  buildHeadlessRunContext,
  resolveCliRunModel,
} from '../runtime/runModel';
import { initLocalCliPlatform } from '../runtime/initPlatform';

import { missingAgentMessage } from './_helpers/agentLookupText';
import { defineCliCommand } from './_helpers/defineCliCommand';
import { emitCliResult } from './_helpers/output';
import {
  AGENT_RUN_GLOBAL_ARGS,
  collectStringFlagValues,
  optionalStringFlagValue,
  optString,
} from './_helpers/globalArgs';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import { resolveCliAgent } from '../runtime/agentResolution';
import { executeCliRequest } from '../runtime/runExecution';
import {
  terminalStatusExitCode,
  type CliRunResult,
} from '../runtime/terminalStatus';
import {
  createStdinWorkflowInputMaterializer,
  expandRunInputs,
  hasMixedStdinWorkflowInputSpecs,
} from '../runtime/workflowInputs';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  expectedOutputFilesForOutputDir,
  formatWorkflowTextResult,
  resolveWorkflowOutput,
} from '../runtime/workflowOutput';

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

/**
 * Resolve the workflow output, mapping a failure to an exit code: an
 * interrupted run yields `Interrupted`, otherwise the run is marked errored and
 * `AgentError` is returned. Returns the display result on success; callers
 * branch on `typeof result === 'number'`.
 */
async function resolveWorkflowDisplayResultOrExit(
  executionId: ReturnType<typeof generateExecutionId>,
  ...args: Parameters<typeof resolveWorkflowOutput>
): Promise<CliRunResult | CliExitCode> {
  const { terminalStatus } = args[4];
  try {
    return (await resolveWorkflowOutput(...args)).displayResult;
  } catch (error) {
    if (terminalStatus === EXECUTION_STATUS.INTERRUPTED) {
      writeErrorStderr(error);
      return CliExitCode.Interrupted;
    }
    await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
    writeErrorStderr(error);
    return CliExitCode.AgentError;
  }
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
  const agent = await resolveCliAgent(init.agent);
  // Pre-validate the resolved agent so usage errors land before stdin is read
  // or the runtime host starts.
  if (!agent) {
    throw new CliUsageError(missingAgentMessage(init.agent));
  }
  if (agent.category !== AgentCategory.Workflow) {
    throw new CliUsageError(
      `Agent "${init.agent}" is a ${agent.category} agent; \`texra run\` only handles workflow agents. Start it interactively with \`texra chat --agent ${init.agent}\`, or run a headless team with \`texra multi-agent run\`.`,
    );
  }
  if (init.output && hasMixedStdinWorkflowInputSpecs(init.inputFiles)) {
    throw new CliUsageError(
      'Use --output-dir for multi-input workflow runs; --output is only for a single final artifact.',
    );
  }

  const model = await resolveCliRunModel(context, init.model, 'run');
  const runContext = buildHeadlessRunContext(context, model);

  const stdinInputFile = createStdinWorkflowInputMaterializer({
    readStdinText: readCliStdinText,
    tempDir: runContext.cwd,
  });
  try {
    const { inputFiles, contextFiles } = await expandRunInputs(
      init.inputFiles,
      init.contextFiles,
      runContext.cwd,
      { stdinInputFile },
    );
    if (init.output && inputFiles.length > 1) {
      throw new CliUsageError(
        'Use --output-dir for multi-input workflow runs; --output is only for a single final artifact.',
      );
    }

    const modelOutputFile =
      init.output && path.isAbsolute(init.output)
        ? path.basename(init.output)
        : init.output;
    const config: AgentConfigPayload = {
      agent: init.agent,
      model,
      inputFiles,
      contextFiles,
      outputFiles: modelOutputFile ? [modelOutputFile] : [],
      cliOutputFile: init.output,
      instruction,
      workingDirectory: runContext.cwd,
      agentCategory: AgentCategory.Workflow,
    };

    const executionId = generateExecutionId();
    const registeredConfig = AgentConfigSchema.parse(config);
    const { result, terminalStatus } = await executeCliRequest(
      { config: registeredConfig, executionId },
      runContext,
      {
        enforceCategory: true,
        registerExecution: true,
        markErrorOnThrow: true,
      },
    );
    const displayResult = await resolveWorkflowDisplayResultOrExit(
      executionId,
      init.output,
      init.outputDir,
      result,
      runContext,
      {
        expectedOutputFiles: init.outputDir
          ? expectedOutputFilesForOutputDir(agent, inputFiles)
          : undefined,
        terminalStatus,
      },
    );
    if (typeof displayResult === 'number') return displayResult;

    emitCliResult(runContext, {
      json: displayResult,
      ndjson: { kind: 'result', result: displayResult },
      text:
        displayResult.category === AgentCategory.Workflow
          ? formatWorkflowTextResult(displayResult)
          : terminalStatus,
    });

    return terminalStatusExitCode(terminalStatus, runContext);
  } finally {
    await stdinInputFile.cleanup();
  }
}

export const runWorkflowCommand = defineCliCommand({
  meta: { name: 'run', description: 'Run a workflow agent' },
  args: {
    ...AGENT_RUN_GLOBAL_ARGS,
    agent: {
      type: 'positional',
      required: true,
      description: 'Workflow agent name',
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
      inputFiles: collectStringFlagValues(ctx.rawArgs, 'input', 'i'),
      contextFiles: collectStringFlagValues(ctx.rawArgs, 'context', 'c'),
      output: optionalStringFlagValue(ctx.rawArgs, 'output'),
      outputDir: optionalStringFlagValue(ctx.rawArgs, 'output-dir'),
      model: optString(ctx.args.model),
      instruction: optString(ctx.args.instruction) ?? '',
      instructionFile: optionalStringFlagValue(ctx.rawArgs, 'instruction-file'),
    }),
});
