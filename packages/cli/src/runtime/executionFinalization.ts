import {
  finalizeExecution,
  releaseOwnedExecutionLeaseBestEffort,
  type FinalizeExecutionInput,
} from '@agent/storage';
import type { ExecutionStatus } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

export type CliFinalizationFailureReporter = (error: Error) => void;
type FailedFinalizationResult = Extract<
  Awaited<ReturnType<typeof finalizeExecution>>,
  { readonly status: 'failed' }
>;

function finalizationFailureMessage(
  result: FailedFinalizationResult,
  executionId: FinalizeExecutionInput['executionId'],
  terminalStatus: ExecutionStatus,
): string {
  const status = terminalStatus.toLowerCase();
  const detail = toErrorMessage(result.error);
  switch (result.stage) {
    case 'flow-record-delete':
      return `Persisted ${status} status for execution ${executionId}, but failed to delete its flow record: ${detail}`;
    case 'terminal-status-and-flow-record-delete':
      return `Failed to persist ${status} status and delete the flow record for execution ${executionId}: ${detail}`;
    case 'terminal-status':
      return `Failed to persist ${status} status for execution ${executionId}: ${detail}`;
  }
}

/**
 * Finalize an execution without replacing the caller's primary result or error.
 * The required reporter keeps durability failures observable at the host boundary.
 */
export async function finalizeCliExecution(
  executionId: FinalizeExecutionInput['executionId'],
  terminalStatus: ExecutionStatus,
  flowRecord: FinalizeExecutionInput['flowRecord'],
  reportFailure: CliFinalizationFailureReporter,
): Promise<void> {
  let result: Awaited<ReturnType<typeof finalizeExecution>>;
  try {
    result = await finalizeExecution({
      executionId,
      terminalStatus,
      flowRecord,
    });
  } catch (error) {
    reportFailure(
      new Error(
        `Execution finalization failed unexpectedly for ${executionId}: ${toErrorMessage(error)}`,
        { cause: error },
      ),
    );
    return;
  } finally {
    await releaseOwnedExecutionLeaseBestEffort(executionId);
  }
  if (result.status === 'durable') return;

  const message = finalizationFailureMessage(
    result,
    executionId,
    terminalStatus,
  );
  reportFailure(new Error(message, { cause: result.error }));
}
