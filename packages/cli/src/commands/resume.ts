import { defineCommand } from 'citty';

import { getAgent, loadAgents } from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { runValidatedExecutionRequest } from '@agent/runtime/runExecutionRequest';
import { toErrorMessage } from '@common/errors/errorMessage';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';

import { installCliApprovalHandlers } from '../runtime/approvalAdapter';
import { CliExitCode } from '../runtime/exitCodes';
import { readCliHistoryConfig, parseCliHistoryId } from '../runtime/history';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';
import { shouldRenderRunProgress } from '../runtime/runProgressRenderer';
import { createCliRuntimeHost } from '../runtime/runtimeHost';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import { shouldHonorRemoteAgentPriority } from './_helpers/remoteAgents';
import {
  readCliTerminalStatus,
  terminalStatusExitCode,
  type CliRunResult,
  type ExecuteAgentResult,
} from './_helpers/terminalStatus';
import {
  formatWorkflowTextResult,
  resolveWorkflowOutput,
  resumeWorkflowOutputFile,
} from './_helpers/workflowOutput';
import type { CliContext } from '../runtime/cliContext';

export async function runResumeExecution(
  context: CliContext,
  id: ExecutionId,
): Promise<number> {
  await initCliPlatform({ ...context, quietLogs: true });
  const config = await readCliHistoryConfig(id);
  if (!config) {
    writeTextStderr(`Execution not found: ${id}`);
    return CliExitCode.Usage;
  }

  const runContext: CliContext = {
    ...context,
    helperModel: config.model,
    quietLogs: true,
    renderRunProgress: shouldRenderRunProgress(context),
  };
  await initCliPlatform(runContext);
  installCliApprovalHandlers(runContext);
  await loadAgents({ includeRemote: false });
  if (
    !getAgent(config.agent) ||
    (await shouldHonorRemoteAgentPriority(config.agent))
  ) {
    await loadAgents();
  }

  const runtimeHost = createCliRuntimeHost(runContext);
  let result: ExecuteAgentResult;
  try {
    result = await runValidatedExecutionRequest(
      { config, executionId: id },
      { runtimeHost },
    );
  } finally {
    await runtimeHost.close();
  }

  const terminalStatus = await readCliTerminalStatus(result);
  let displayResult: CliRunResult;
  try {
    ({ displayResult } = await resolveWorkflowOutput(
      resumeWorkflowOutputFile(config),
      undefined,
      result,
      runContext,
      { terminalStatus },
    ));
  } catch (error) {
    if (terminalStatus === EXECUTION_STATUS.INTERRUPTED) {
      writeTextStderr(toErrorMessage(error));
      return CliExitCode.Interrupted;
    }
    await writeTerminalStatus(id, EXECUTION_STATUS.ERROR);
    writeTextStderr(toErrorMessage(error));
    return CliExitCode.AgentError;
  }

  emitCliResult(runContext, {
    json: displayResult,
    ndjson: { kind: 'result', result: displayResult },
    text:
      displayResult.category === AgentCategory.Workflow
        ? formatWorkflowTextResult(displayResult)
        : displayResult.status,
  });

  return terminalStatusExitCode(terminalStatus, runContext);
}

export const resumeCommand = defineCommand({
  meta: { name: 'resume', description: 'Re-run a stored execution config' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Execution id from `texra history list`',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const id = parseCliHistoryId(ctx.args.id);
    if (!id) {
      writeTextStderr(`Invalid execution id: ${ctx.args.id}`);
      setExitCode(CliExitCode.Usage);
      return;
    }
    setExitCode(await runResumeExecution(context, id));
  },
});
