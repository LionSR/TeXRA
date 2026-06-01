import * as path from 'node:path';

import { loadAgents } from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { EXECUTION_STATUS } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';

import { installCliApprovalHandlers } from '../runtime/approvalAdapter';
import { CliUsageError } from '../runtime/cliContext';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeErrorStderr } from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import {
  buildHeadlessRunContext,
  resolveCliRunModel,
} from './_helpers/modelArg';
import { emitCliResult } from './_helpers/output';
import {
  GLOBAL_ARGS,
  collectStringFlagValues,
  optString,
} from './_helpers/globalArgs';
import { resolveAgentWithRemoteFallback } from './_helpers/remoteAgents';
import { executeCliRequest } from './_helpers/runExecution';
import {
  terminalStatusExitCode,
  type CliRunResult,
} from './_helpers/terminalStatus';
import { expandRunInputs } from './_helpers/workflowInputs';
import {
  assertOutputDirAvailable,
  assertOutputFileAvailable,
  expectedOutputFilesForOutputDir,
  formatWorkflowTextResult,
  resolveWorkflowOutput,
} from './_helpers/workflowOutput';
import type { CliContext } from '../runtime/cliContext';

interface WorkflowRunInit {
  readonly agent: string;
  readonly inputFiles: string[];
  readonly contextFiles: string[];
  readonly output?: string;
  readonly outputDir?: string;
  readonly model?: string;
  readonly instruction: string;
}

async function runWorkflowAgent(
  context: CliContext,
  init: WorkflowRunInit,
): Promise<number> {
  const model = await resolveCliRunModel(context, init.model, 'run');
  const runContext = buildHeadlessRunContext(context, model);
  if (init.output && init.outputDir) {
    throw new CliUsageError('Use either --output or --output-dir, not both.');
  }
  // Reject `--output-dir <path>` early when the path already points at a
  // non-directory (else we'd run the full workflow and EEXIST at the end).
  await assertOutputDirAvailable(init.outputDir, runContext.cwd);
  // Same fast-fail for `--output <path>`: existing directory or file-typed
  // parent component blows up at copy time (`EISDIR` / `EEXIST`) after the
  // full agent run otherwise.
  await assertOutputFileAvailable(init.output, runContext.cwd);
  const { inputFiles, contextFiles } = await expandRunInputs(
    init.inputFiles,
    init.contextFiles,
    runContext.cwd,
  );
  if (init.output && inputFiles.length > 1) {
    throw new CliUsageError(
      'Use --output-dir for multi-input workflow runs; --output is only for a single final artifact.',
    );
  }

  await initCliPlatform(runContext);
  installCliApprovalHandlers(runContext);
  await loadAgents({ includeRemote: false });
  const agent = await resolveAgentWithRemoteFallback(init.agent);
  // Pre-validate the resolved agent so usage errors land before the runtime
  // host starts: an unknown name or wrong category should be exit 2 (Usage),
  // not exit 1 (AgentError) raised mid-run.
  if (!agent) {
    throw new CliUsageError(
      `Agent not found: ${init.agent}. Use \`texra agents list\` to see available agents.`,
    );
  }
  if (agent.category !== AgentCategory.Workflow) {
    throw new CliUsageError(
      `Agent "${init.agent}" is a ${agent.category} agent; \`texra run\` only handles workflow agents. Start it interactively with \`texra chat --agent ${init.agent}\`, or run a headless team with \`texra multi-agent run\`.`,
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
    instruction: init.instruction,
    workingDirectory: runContext.cwd,
    agentCategory: AgentCategory.Workflow,
  };

  const executionId = generateExecutionId();
  const registeredConfig = AgentConfigSchema.parse(config);
  const { result, terminalStatus } = await executeCliRequest(
    { config: registeredConfig, executionId },
    runContext,
    { enforceCategory: true, registerExecution: true, markErrorOnThrow: true },
  );
  let displayResult: CliRunResult;
  try {
    ({ displayResult } = await resolveWorkflowOutput(
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
    ));
  } catch (error) {
    if (terminalStatus === EXECUTION_STATUS.INTERRUPTED) {
      writeErrorStderr(error);
      return CliExitCode.Interrupted;
    }
    await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
    writeErrorStderr(error);
    return CliExitCode.AgentError;
  }

  emitCliResult(runContext, {
    json: displayResult,
    ndjson: { kind: 'result', result: displayResult },
    text:
      displayResult.category === AgentCategory.Workflow
        ? formatWorkflowTextResult(displayResult)
        : result.status,
  });

  return terminalStatusExitCode(terminalStatus, runContext);
}

export const runWorkflowCommand = defineCliCommand({
  meta: { name: 'run', description: 'Run a workflow agent' },
  args: {
    ...GLOBAL_ARGS,
    agent: {
      type: 'positional',
      required: true,
      description: 'Workflow agent name',
    },
    input: {
      type: 'string',
      alias: 'i',
      required: true,
      description:
        'Input file passed to the workflow agent (repeatable; use `-` to read stdin)',
    },
    context: {
      type: 'string',
      alias: 'c',
      description:
        'Read-only context file passed to the workflow agent (repeatable)',
    },
    output: {
      type: 'string',
      description:
        'Output file for a single-input run (use --output-dir for multi-input)',
    },
    'output-dir': {
      type: 'string',
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
  },
  run: (context, ctx) =>
    runWorkflowAgent(context, {
      agent: ctx.args.agent,
      inputFiles: collectStringFlagValues(ctx.rawArgs, 'input', 'i'),
      contextFiles: collectStringFlagValues(ctx.rawArgs, 'context', 'c'),
      output: optString(ctx.args.output),
      outputDir: optString(ctx.args['output-dir']),
      model: optString(ctx.args.model),
      instruction: optString(ctx.args.instruction) ?? '',
    }),
});
