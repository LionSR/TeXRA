import { finalizeExecution, type FinalizeExecutionInput } from '@agent/storage';

/** Apply the CLI's strict policy for execution finalization failures. */
export async function finalizeCliExecutionOrThrow(
  executionId: FinalizeExecutionInput['executionId'],
  terminalStatus: string,
  flowRecord: FinalizeExecutionInput['flowRecord'],
): Promise<void> {
  const result = await finalizeExecution({
    executionId,
    terminalStatus,
    flowRecord,
  });
  if (result.status === 'failed') throw result.error;
}
