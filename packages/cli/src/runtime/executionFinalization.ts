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
  const result = await finalizeExecution({
    executionId,
    terminalStatus,
    flowRecord,
  });
  if (result.status === 'durable') return;

  reportFailure(
    new Error(
      `Failed to persist ${terminalStatus.toLowerCase()} status for execution ${executionId}: ${toErrorMessage(result.error)}`,
      { cause: result.error },
    ),
  );
}
