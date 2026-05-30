import { loadAgents } from '@agent/index';
import { writeTerminalStatus } from '@agent/storage';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { EXECUTION_STATUS, type ExecutionId } from '@shared/schemas';

import { installCliApprovalHandlers } from '../runtime/approvalAdapter';
import { CliExitCode } from '../runtime/exitCodes';
import { readCliHistoryConfig, parseCliHistoryId } from '../runtime/history';
import { initCliPlatform } from '../runtime/initPlatform';
import { writeErrorStderr, writeTextStderr } from '../runtime/logSinks';
import { shouldRenderRunProgress } from '../runtime/runProgressRenderer';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import { resolveAgentWithRemoteFallback } from './_helpers/remoteAgents';
import { executeCliRequest } from './_helpers/runExecution';
import {
  terminalStatusExitCode,
  type CliRunResult,
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
  await resolveAgentWithRemoteFallback(config.agent);

  const { result, terminalStatus } = await executeCliRequest(
    { config, executionId: id },
    runContext,
  );
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
      writeErrorStderr(error);
      return CliExitCode.Interrupted;
    }
    await writeTerminalStatus(id, EXECUTION_STATUS.ERROR);
    writeErrorStderr(error);
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

export const resumeCommand = defineCliCommand({
  meta: { name: 'resume', description: 'Re-run a stored execution config' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Execution id from `texra history list`',
    },
  },
  run: (context, ctx) => {
    const id = parseCliHistoryId(ctx.args.id);
    if (!id) {
      writeTextStderr(`Invalid execution id: ${ctx.args.id}`);
      return Promise.resolve(CliExitCode.Usage);
    }
    return runResumeExecution(context, id);
  },
});
