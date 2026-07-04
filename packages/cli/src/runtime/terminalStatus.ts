import { getExecutionStore } from '@agent/storage';
import { runAgent } from '@agent/runtime/runAgent';

import {
  legacyEndGroupStatusForOutcome,
  runOutcomeToExecutionStatus,
} from '@common/constants/streamStatus';
import {
  EXECUTION_STATUS,
  executionStatusToRunOutcome,
  type ExecutionStatus,
  type RunOutcome,
} from '@shared/schemas';

import { hasCliApprovalDenied } from './approvalAdapter';
import { CliExitCode } from './exitCodes';
import type { CliContext } from './cliContext';

export type ExecuteAgentResult = Awaited<ReturnType<typeof runAgent>>;

type CliRunResultFor<T extends ExecuteAgentResult> = T & {
  /** @deprecated Use `outcome`; this is a frozen projection for JSON-output compatibility. */
  status: ExecutionStatus;
  /** @deprecated Use `outcome`; this is a frozen 2-value projection for JSON-output compatibility. */
  endGroupStatus: 'error' | 'stopped';
  /** @deprecated Use `outcome`; this is a frozen projection for JSON-output compatibility. */
  terminalStatus: ExecutionStatus;
  workingDirectory?: string;
  runDirectory?: string;
  copiedOutput?: string;
  copiedOutputs?: string[];
};

export type CliRunResult = ExecuteAgentResult extends infer T
  ? T extends ExecuteAgentResult
    ? CliRunResultFor<T>
    : never
  : never;

export type CliToolUseRunResult = Extract<
  CliRunResult,
  { category: 'toolUse' }
>;

/** Display text for a finished tool-use run: the last response if present,
 *  otherwise a terse status/execution-id summary. */
export function toolUseResultText(result: CliToolUseRunResult): string {
  return (
    result.lastResponse?.trim() ||
    `${result.status}\nExecution: ${result.executionId}`
  );
}

export function cliTerminalStatus(
  result: ExecuteAgentResult,
  storedOutcome?: RunOutcome,
): ExecutionStatus {
  return runOutcomeToExecutionStatus(storedOutcome ?? result.outcome);
}

export function createCliRunResult<T extends ExecuteAgentResult>(
  result: T,
  extras: {
    readonly terminalStatus?: ExecutionStatus;
    readonly workingDirectory?: string;
    readonly runDirectory?: string;
    readonly copiedOutput?: string;
    readonly copiedOutputs?: string[];
  } = {},
): T extends ExecuteAgentResult ? CliRunResultFor<T> : never {
  const { terminalStatus: resolvedTerminalStatus, ...metadata } = extras;
  const terminalStatus =
    resolvedTerminalStatus ?? runOutcomeToExecutionStatus(result.outcome);
  const terminalOutcome =
    executionStatusToRunOutcome(terminalStatus) ?? result.outcome;
  return {
    ...result,
    status: terminalStatus,
    endGroupStatus: legacyEndGroupStatusForOutcome(terminalOutcome),
    terminalStatus,
    ...metadata,
  } as T extends ExecuteAgentResult ? CliRunResultFor<T> : never;
}

/** Map a terminal execution status to the CLI process exit code, treating an
 *  approval-denied error distinctly from a generic agent error. */
export function terminalStatusExitCode(
  terminalStatus: ExecutionStatus,
  context: CliContext,
): CliExitCode {
  if (terminalStatus === EXECUTION_STATUS.ERROR) {
    return hasCliApprovalDenied(context)
      ? CliExitCode.ApprovalDenied
      : CliExitCode.AgentError;
  }
  if (terminalStatus === EXECUTION_STATUS.INTERRUPTED) {
    return CliExitCode.Interrupted;
  }
  return CliExitCode.Success;
}

export async function readCliTerminalStatus(
  result: ExecuteAgentResult,
): Promise<ExecutionStatus> {
  const meta = await getExecutionStore(result.executionId)
    .readMeta()
    .catch(() => undefined);
  return cliTerminalStatus(result, meta?.outcome);
}
