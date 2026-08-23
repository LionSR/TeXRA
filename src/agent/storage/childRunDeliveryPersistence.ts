/**
 * Best-effort persistence of the artifacts delivered by a child run. A lost
 * execution lease is not a best-effort failure: the run has been displaced
 * and must stop, so that one error propagates.
 */
import type { ExecutionId } from '@shared/schemas';

import {
  persistChildRunReport,
  persistChildRunResultMeta,
} from './childRunPersistence';
import {
  ExecutionLeaseLostError,
  markOwnedExecutionLeaseUndurable,
} from './executionLease';
import type { ResultMeta } from './resultMeta';

export async function persistChildRunDeliveryBestEffort(
  executionId: ExecutionId,
  message: string,
  resultMeta: ResultMeta | undefined,
  onFailure: (kind: 'report' | 'result manifest', error: unknown) => void,
): Promise<void> {
  const [report, manifest] = await Promise.all([
    persistChildRunReport(executionId, message),
    resultMeta
      ? persistChildRunResultMeta(executionId, resultMeta)
      : Promise.resolve({ kind: 'persisted' } as const),
  ]);
  for (const [kind, result] of [
    ['report', report],
    ['result manifest', manifest],
  ] as const) {
    if (result.kind !== 'failed') continue;
    if (result.err instanceof ExecutionLeaseLostError) throw result.err;
    markOwnedExecutionLeaseUndurable(executionId);
    onFailure(kind, result.err);
  }
}
