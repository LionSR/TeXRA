import { writeTerminalStatus } from '@agent/storage';
import { runAgent } from '@agent/runtime/runAgent';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import type { ValidatedExecutionRequest } from '@agent/core/execution/executionRequests';
import { EXECUTION_STATUS, type ExecutionStatus } from '@shared/schemas';

import { approvalPromptsUnavailable } from './approvalPolicyAvailability';
import { installCliApprovalHandlers } from './approvalAdapter';
import { createCliRuntimeHost } from './runtimeHost';
import {
  readCliTerminalStatus,
  type ExecuteAgentResult,
} from './terminalStatus';
import type { CliContext } from './cliContext';

const NON_TUI_CLI_UNAVAILABLE_TOOLS = ['inquiry'] as const;

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
  /** Additional tools unavailable in this CLI runtime. */
  readonly runtimeUnavailableTools?: readonly string[];
  /** Wrap the run (e.g. multi-agent preset visibility) without leaking the
   *  runtime-host lifecycle into the caller. */
  readonly wrap?: (
    run: () => Promise<ExecuteAgentResult>,
  ) => Promise<ExecuteAgentResult>;
}

/**
 * Shared headless-execution skeleton for `run`, `agents run`, and
 * `multi-agent run`: stand up a runtime host, run the request (optionally
 * wrapped), always close the host, and resolve the terminal status.
 * Centralizing this stops the three runners from drifting apart on host
 * lifecycle and status handling, which is how their behavior diverged before.
 */
export async function executeCliRequest(
  request: ValidatedExecutionRequest,
  runContext: CliContext,
  options: CliExecuteOptions = {},
): Promise<{ result: ExecuteAgentResult; terminalStatus: ExecutionStatus }> {
  const runtimeHost = createCliRuntimeHost(runContext);
  // Present terminal-error toasts from the run's `result` event through the same
  // runtimeHost path the lifecycle used before (so ndjson / logger output is
  // unchanged); the lifecycle no longer emits them directly.
  const detachResultToast = attachTerminalResultToast(
    defaultSession(),
    runtimeHost,
  );
  const uninstallApprovalHandlers = installCliApprovalHandlers(runContext, {
    beforePrompt: () => runtimeHost.prepareInteractivePrompt?.(),
  });
  const invoke = (): Promise<ExecuteAgentResult> =>
    runAgent(request, {
      runtimeHost,
      enforceCategory: options.enforceCategory,
      registerExecution: options.registerExecution,
      stopAfterCycle: options.stopAfterCycle,
      approvalPromptsUnavailable: approvalPromptsUnavailable(runContext),
      runtimeUnavailableTools: [
        ...NON_TUI_CLI_UNAVAILABLE_TOOLS,
        ...(options.runtimeUnavailableTools ?? []),
      ],
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
    detachResultToast();
    uninstallApprovalHandlers();
    await runtimeHost.close();
  }

  const terminalStatus = await readCliTerminalStatus(result);
  return { result, terminalStatus };
}
