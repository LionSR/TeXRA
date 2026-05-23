import * as path from 'node:path';

import { defineCommand } from 'citty';

import { getAgent, loadAgents } from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { runValidatedExecutionRequest } from '@agent/runtime/runExecutionRequest';
import { toErrorMessage } from '@common/errors/errorMessage';
import { EXECUTION_STATUS } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';

import { installCliApprovalHandlers } from '../runtime/approvalAdapter';
import { CliUsageError } from '../runtime/cliContext';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  resolveConfiguredModel,
} from '../runtime/cliConfig';
import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
import { shouldRenderRunProgress } from '../runtime/runProgressRenderer';
import { createCliRuntimeHost } from '../runtime/runtimeHost';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import {
  GLOBAL_ARGS,
  collectStringFlagValues,
  optString,
} from './_helpers/globalArgs';
import { shouldHonorRemoteAgentPriority } from './_helpers/remoteAgents';
import {
  readCliTerminalStatus,
  terminalStatusExitCode,
  type CliRunResult,
  type ExecuteAgentResult,
} from './_helpers/terminalStatus';
import { expandWorkflowInputSpecs } from './_helpers/workflowInputs';
import {
  assertOutputDirAvailable,
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
  const model =
    init.model?.trim() ||
    context.envModel ||
    resolveConfiguredModel(context.cliConfig, 'run') ||
    CLI_BUILTIN_DEFAULT_MODEL;
  const renderRunProgress = shouldRenderRunProgress(context);
  const runContext: CliContext = {
    ...context,
    helperModel: model,
    quietLogs: true,
    renderRunProgress,
  };
  if (init.output && init.outputDir) {
    throw new CliUsageError('Use either --output or --output-dir, not both.');
  }
  // Reject `--output-dir <path>` early when the path already points at a
  // non-directory (else we'd run the full workflow and EEXIST at the end).
  await assertOutputDirAvailable(init.outputDir, runContext.cwd);
  const inputFiles = await expandWorkflowInputSpecs(
    init.inputFiles,
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
  let agent = getAgent(init.agent);
  if (!agent || (await shouldHonorRemoteAgentPriority(init.agent))) {
    await loadAgents();
    agent = getAgent(init.agent);
  }
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
      `Agent "${init.agent}" is a ${agent.category} agent; use \`texra chat\` or \`texra multi-agent run\` instead.`,
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
    contextFiles: init.contextFiles,
    outputFiles: modelOutputFile ? [modelOutputFile] : [],
    cliOutputFile: init.output,
    instruction: init.instruction,
    workingDirectory: runContext.cwd,
    agentCategory: AgentCategory.Workflow,
  };

  const executionId = generateExecutionId();
  const registeredConfig = AgentConfigSchema.parse(config);
  const runtimeHost = createCliRuntimeHost(runContext);
  let result: ExecuteAgentResult;
  try {
    result = await runValidatedExecutionRequest(
      { config: registeredConfig, executionId },
      {
        runtimeHost,
        enforceCategory: true,
        registerExecution: true,
      },
    );
  } catch (error) {
    await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
    throw error;
  } finally {
    await runtimeHost.close();
  }

  const terminalStatus = await readCliTerminalStatus(result);
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
      writeTextStderr(toErrorMessage(error));
      return CliExitCode.Interrupted;
    }
    await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
    writeTextStderr(toErrorMessage(error));
    return CliExitCode.AgentError;
  }

  if (runContext.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(displayResult, null, 2));
  } else if (runContext.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'result',
      ts: new Date().toISOString(),
      result: displayResult,
    });
  } else if (displayResult.category === AgentCategory.Workflow) {
    writeTextStdout(formatWorkflowTextResult(displayResult));
  } else {
    writeTextStdout(result.status);
  }

  return terminalStatusExitCode(terminalStatus, runContext);
}

export const runWorkflowCommand = defineCommand({
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
      description: 'Input file passed to the workflow agent',
    },
    context: {
      type: 'string',
      alias: 'c',
      description: 'Read-only context file passed to the workflow agent',
    },
    output: { type: 'string', description: 'Output file path' },
    'output-dir': {
      type: 'string',
      description: 'Directory to copy multi-input workflow outputs into',
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
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(
      await runWorkflowAgent(context, {
        agent: ctx.args.agent,
        inputFiles: collectStringFlagValues(ctx.rawArgs, 'input', 'i'),
        contextFiles: collectStringFlagValues(ctx.rawArgs, 'context', 'c'),
        output: optString(ctx.args.output),
        outputDir: optString(ctx.args['output-dir']),
        model: optString(ctx.args.model),
        instruction: optString(ctx.args.instruction) ?? '',
      }),
    );
  },
});
