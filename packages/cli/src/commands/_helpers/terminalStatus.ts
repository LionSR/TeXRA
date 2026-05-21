import { getExecutionStore } from '@agent/storage';
import type { OutputFileSummary } from '@agent/runtime/AgentFlowResult';
import { runValidatedExecutionRequest } from '@agent/runtime/runExecutionRequest';
import { EXECUTION_STATUS, type ExecutionStatus } from '@shared/schemas';

export type ExecuteAgentResult = Awaited<
  ReturnType<typeof runValidatedExecutionRequest>
>;

type CliRunResultFor<T extends ExecuteAgentResult> = Omit<T, 'status'> & {
  status: ExecutionStatus;
  endGroupStatus: T['status'];
  terminalStatus: ExecutionStatus;
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
  return (
    value === EXECUTION_STATUS.COMPLETED ||
    value === EXECUTION_STATUS.ERROR ||
    value === EXECUTION_STATUS.INTERRUPTED
  );
}

export function cliTerminalStatus(
  result: ExecuteAgentResult,
  storedTerminalStatus?: string,
): ExecutionStatus {
  if (isExecutionStatus(storedTerminalStatus)) return storedTerminalStatus;
  if (result.status === 'error') return EXECUTION_STATUS.ERROR;
  return EXECUTION_STATUS.COMPLETED;
}

export function createCliRunResult<T extends ExecuteAgentResult>(
  result: T,
  terminalStatus: ExecutionStatus,
  extras: {
    readonly runDirectory?: string;
    readonly copiedOutput?: string;
    readonly copiedOutputs?: string[];
  } = {},
): T extends ExecuteAgentResult ? CliRunResultFor<T> : never {
  const { status: endGroupStatus, ...rest } = result;
  return {
    ...rest,
    status: terminalStatus,
    endGroupStatus,
    terminalStatus,
    ...extras,
  } as T extends ExecuteAgentResult ? CliRunResultFor<T> : never;
}

export async function readCliTerminalStatus(
  result: ExecuteAgentResult,
): Promise<ExecutionStatus> {
  try {
    const meta = await getExecutionStore(result.executionId).readMeta();
    return cliTerminalStatus(result, meta?.terminalStatus);
  } catch {
    return cliTerminalStatus(result);
  }
}

export type { OutputFileSummary };
