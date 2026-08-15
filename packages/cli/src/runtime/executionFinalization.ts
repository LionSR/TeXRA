import {
  releaseExecutionLeaseAfterArtifacts,
  type SessionHandle,
} from '@agent/runtime';
import {
  finalizeExecution,
  markOwnedExecutionLeaseUndurable,
  type FinalizeExecutionInput,
} from '@agent/storage';
import type { RunOutcome } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

type CliFinalizationFailureReporter = (error: Error) => void;
type FailedFinalizationResult = Extract<
  Awaited<ReturnType<typeof finalizeExecution>>,
  { readonly status: 'failed' }
>;

function finalizationFailureMessage(
  result: FailedFinalizationResult,
  executionId: FinalizeExecutionInput['executionId'],
  outcome: RunOutcome,
): string {
  const detail = toErrorMessage(result.error);
  switch (result.stage) {
    case 'flow-record-delete':
      return `Persisted ${outcome} status for execution ${executionId}, but failed to delete its flow record: ${detail}`;
    case 'terminal-status-and-flow-record-delete':
      return `Failed to persist ${outcome} status and delete the flow record for execution ${executionId}: ${detail}`;
    case 'terminal-status':
      return `Failed to persist ${outcome} status for execution ${executionId}: ${detail}`;
  }
}

/**
 * Finalize an execution without replacing the caller's primary result or error.
 * The required reporter keeps durability failures observable at the host boundary.
 */
export async function finalizeCliExecution(
  executionId: FinalizeExecutionInput['executionId'],
  outcome: RunOutcome,
  flowRecord: FinalizeExecutionInput['flowRecord'],
  reportFailure: CliFinalizationFailureReporter,
): Promise<boolean> {
  let result: Awaited<ReturnType<typeof finalizeExecution>>;
  try {
    result = await finalizeExecution({
      executionId,
      outcome,
      flowRecord,
    });
  } catch (error) {
    markOwnedExecutionLeaseUndurable(executionId);
    reportFailure(
      new Error(
        `Execution finalization failed unexpectedly for ${executionId}: ${toErrorMessage(error)}`,
        { cause: error },
      ),
    );
    return false;
  }
  if (result.status === 'durable') return true;
  markOwnedExecutionLeaseUndurable(executionId);

  const message = finalizationFailureMessage(result, executionId, outcome);
  reportFailure(new Error(message, { cause: result.error }));
  return false;
}

/**
 * Drain a CLI session's artifacts before releasing its execution lease.
 * This host-local seam lets CLI lifecycle tests replace the release operation
 * without mocking the public agent-runtime barrel, which would replace every
 * runtime export consumed by the same test module.
 */
export function releaseCliExecutionLeaseAfterArtifacts(
  session: SessionHandle,
  executionId: FinalizeExecutionInput['executionId'],
): Promise<void> {
  return releaseExecutionLeaseAfterArtifacts(session, executionId);
}
