import { writeTerminalStatus } from '@agent/storage';
import { runAgent } from '@agent/runtime/runAgent';
import type { ValidatedExecutionRequest } from '@agent/core/execution/executionRequests';

import type { CliContext } from '@cli/runtime/cliContext';
import { createCliRuntimeHost } from '@cli/runtime/runtimeHost';
import { EXECUTION_STATUS, type ExecutionStatus } from '@shared/schemas';

import { approvalPromptsUnavailable } from './approvalPolicyInstruction';
import {
  readCliTerminalStatus,
  type ExecuteAgentResult,
} from './terminalStatus';

export interface CliExecuteOptions {
  /** Forwarded to `runAgent`. */
  readonly enforceCategory?: boolean;
  readonly registerExecution?: boolean;
  /**
   * Mark the execution ERROR before rethrowing. The headless `run` /
   * `multi-agent run` paths own the status they create; `resume` re-runs a
   * stored config and must leave the prior terminal status untouched.
   */
  readonly markErrorOnThrow?: boolean;
  /** Stop a tool-use execution after one model/tool cycle. */
  readonly stopAfterCycle?: boolean;
  /** Wrap the run (e.g. multi-agent preset visibility) without leaking the
   *  runtime-host lifecycle into the caller. */
  readonly wrap?: (
    run: () => Promise<ExecuteAgentResult>,
  ) => Promise<ExecuteAgentResult>;
}

/**
 * Shared headless-execution skeleton for `run`, `multi-agent run`, and
 * `resume`: stand up a runtime host, run the request (optionally wrapped),
 * always close the host, and resolve the terminal status. Centralizing this
 * stops the three runners from drifting apart on host lifecycle and status
 * handling, which is how their behavior diverged before.
 */
export async function executeCliRequest(
  request: ValidatedExecutionRequest,
  runContext: CliContext,
  options: CliExecuteOptions = {},
): Promise<{ result: ExecuteAgentResult; terminalStatus: ExecutionStatus }> {
  const runtimeHost = createCliRuntimeHost(runContext);
  const invoke = (): Promise<ExecuteAgentResult> =>
    runAgent(request, {
      runtimeHost,
      enforceCategory: options.enforceCategory,
      registerExecution: options.registerExecution,
      stopAfterCycle: options.stopAfterCycle,
      approvalPromptsUnavailable: approvalPromptsUnavailable(runContext),
    });

  let result: ExecuteAgentResult;
  try {
    result = await (options.wrap ? options.wrap(invoke) : invoke());
  } catch (error) {
    if (options.markErrorOnThrow && request.executionId) {
      await writeTerminalStatus(request.executionId, EXECUTION_STATUS.ERROR);
    }
    throw error;
  } finally {
    await runtimeHost.close();
  }

  const terminalStatus = await readCliTerminalStatus(result);
  return { result, terminalStatus };
}
