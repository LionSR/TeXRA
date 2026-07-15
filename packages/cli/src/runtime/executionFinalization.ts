import { finalizeExecution, type FinalizeExecutionInput } from '@agent/storage';
import { toErrorMessage } from '@utils/errors/errorMessage';

export type CliFinalizationFailureReporter = (error: Error) => void;

/**
 * Finalize an execution without replacing the caller's primary result or error.
 * The required reporter keeps durability failures observable at the host boundary.
 */
export async function finalizeCliExecution(
  executionId: FinalizeExecutionInput['executionId'],
  terminalStatus: string,
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
  }
  if (result.status === 'durable') return;

  const message =
    result.stage === 'flow-record-delete'
      ? `Persisted ${terminalStatus.toLowerCase()} status for execution ${executionId}, but failed to delete its flow record: ${toErrorMessage(result.error)}`
      : result.stage === 'terminal-status-and-flow-record-delete'
        ? `Failed to persist ${terminalStatus.toLowerCase()} status and delete the flow record for execution ${executionId}: ${toErrorMessage(result.error)}`
        : `Failed to persist ${terminalStatus.toLowerCase()} status for execution ${executionId}: ${toErrorMessage(result.error)}`;
  reportFailure(new Error(message, { cause: result.error }));
}
