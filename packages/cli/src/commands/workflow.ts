import { buildCliWorkflowResultMeta, getExecutionStore } from '@agent/storage';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { EXECUTION_STATUS, RUN_OUTCOME } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  CliUsageError,
  readCliStdinText,
  type CliContext,
} from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { finalizeCliExecution } from '../runtime/executionFinalization';
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
import { emitCliResult } from './_helpers/output';
import {
  AGENT_RUN_GLOBAL_ARGS,
  collectCommonAgentRunFlags,
  optionalStringFlagValue,
  optString,
} from './_helpers/globalArgs';
import { resolveFileBackedInstruction } from './_helpers/instructionFile';
import { executeCliConfig } from '../runtime/runExecution';
import {
  serializeCliRunResult,
  runOutcomeExitCode,
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
} from '../runtime/workflowOutput';

const MULTI_INPUT_OUTPUT_MESSAGE =
  'Use --output-dir for multi-input workflow runs; --output is only for a single final artifact.';

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
      const config: AgentConfigPayload = {
        agent: init.agent,
        model,
        inputFiles,
        contextFiles,
        outputFiles: [],
        cliOutputFile: init.output,
        instruction,
        workingDirectory: runContext.cwd,
        agentCategory: AgentCategory.Workflow,
      };

      let workflowResult: CliWorkflowRunResult | undefined;
      let workflowOutputError: unknown;
      const execution = await executeCliConfig(config, runContext, {
        enforceCategory: true,
        registerExecution: true,
        expectedCategory: AgentCategory.Workflow,
        categoryMismatchMessage: `Agent "${init.agent}" resolved to a non workflow run.`,
        openWorkflowOutput: async (result) => {
          try {
            workflowResult = await resolveWorkflowOutput(
              init.output,
              init.outputDir,
              result,
              runContext,
              {
                expectedOutputFiles: init.outputDir
                  ? expectedOutputFilesForOutputDir(agent, inputFiles)
                  : undefined,
              },
            );
            await persistWorkflowResultMeta(
              result.executionId,
              buildCliWorkflowResultMeta(result, {
                outcome: result.outcome,
                copiedOutput: workflowResult.copiedOutput,
                copiedOutputs: workflowResult.copiedOutputs,
              }),
            );
          } catch (error) {
            workflowOutputError = error;
            await persistWorkflowResultMeta(
              result.executionId,
              buildCliWorkflowResultMeta(result, {
                outcome:
                  result.outcome === RUN_OUTCOME.CANCELLED
                    ? result.outcome
                    : RUN_OUTCOME.FAILED,
              }),
            );
            if (result.outcome !== RUN_OUTCOME.CANCELLED) {
              await finalizeCliExecution(
                result.executionId,
                EXECUTION_STATUS.ERROR,
                'delete',
                (finalizationError) =>
                  writeTextStderr(
                    `Warning: ${toErrorMessage(finalizationError)}`,
                  ),
              );
            }
          }
        },
      });
      if (!execution.ok) return execution.exitCode;

      const { result } = execution;
      if (workflowOutputError !== undefined) {
        if (result.outcome === RUN_OUTCOME.CANCELLED) {
          writeErrorStderr(workflowOutputError);
          return CliExitCode.Interrupted;
        }
        writeErrorStderr(workflowOutputError);
        return CliExitCode.AgentError;
      }
      if (!workflowResult) {
        throw new Error(
          'Workflow output was not finalized before lease release.',
        );
      }

      const displayResult = serializeCliRunResult(workflowResult);
      emitCliResult(runContext, {
        json: displayResult,
        ndjson: { kind: 'result', result: displayResult },
        text: formatWorkflowTextResult(workflowResult),
      });

      return runOutcomeExitCode(result.outcome, runContext);
    },
  );
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
