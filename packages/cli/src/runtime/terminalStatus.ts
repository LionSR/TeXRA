import { getExecutionStore } from '@agent/storage';
import { runAgent } from '@agent/runtime/runAgent';

import { projectRunOutcome } from '@common/constants/streamStatus';
import {
  EXECUTION_STATUS,
  ExecutionStatusSchema,
  type ExecutionStatus,
} from '@shared/schemas';

import { hasCliApprovalDenied } from './approvalAdapter';
import { CliExitCode } from './exitCodes';
import type { CliContext } from './cliContext';

export type ExecuteAgentResult = Awaited<ReturnType<typeof runAgent>>;

type CliRunResultFor<T extends ExecuteAgentResult> = T & {
  status: ExecutionStatus;
  /** Legacy 2-value projection kept for JSON-output compatibility. */
  endGroupStatus: 'error' | 'stopped';
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

function isExecutionStatus(
  value: string | undefined,
): value is ExecutionStatus {
  // Schema is the source of truth — no hand-maintained value list.
  return ExecutionStatusSchema.safeParse(value).success;
}

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
  storedTerminalStatus?: string,
): ExecutionStatus {
  if (isExecutionStatus(storedTerminalStatus)) return storedTerminalStatus;
  return projectRunOutcome(result.outcome).executionStatus;
}

export function createCliRunResult<T extends ExecuteAgentResult>(
  result: T,
  terminalStatus: ExecutionStatus,
  extras: {
    readonly workingDirectory?: string;
    readonly runDirectory?: string;
    readonly copiedOutput?: string;
    readonly copiedOutputs?: string[];
  } = {},
): T extends ExecuteAgentResult ? CliRunResultFor<T> : never {
  return {
    ...result,
    status: terminalStatus,
    endGroupStatus: projectRunOutcome(result.outcome).endGroupStatus,
    terminalStatus,
    ...extras,
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
  return cliTerminalStatus(result, meta?.terminalStatus);
}
